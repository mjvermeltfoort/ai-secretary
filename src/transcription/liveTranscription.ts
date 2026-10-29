import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import { IndexedDbSegmentStore, type LocalSegment, type SegmentStore } from "../recording/localSegmentStore";
import type { CheckpointStore, LiveCheckpoint } from "../recording/meetingCheckpoint";
import { verifySegment } from "../recording/exportRecording";
import { readWav, SAMPLE_RATE } from "../recording/pcm";
import type { TranscriptResult } from "./transcriptionClient";
const createToken = httpsCallable<{ meetingId: string }, { value: string; expiresAt: number }>(functions, "createTranscriptionSession");
export type LiveState = "idle" | "connecting" | "live" | "recovering" | "offline" | "blocked";
interface Options {
  store?: SegmentStore & CheckpointStore;
  onRestore?: (turns: TranscriptResult[]) => void;
  rotationMs?: number;
  onIssue?: (message:string) => void;
  retryDelay?: (attempt: number) => number;
}
interface Entry { segment: LocalSegment; start: number; end: number; }
interface Turn { sequence: number; start: number; end: number; silence: number; replayed: boolean; itemId?: string; text: string; }
const FRAME = SAMPLE_RATE / 10;
const empty = (): LiveCheckpoint => ({ version: 1, cursor: 0, nextSequence: 1_000_000, turns: [] });

/** Only persisted audio is sent. A cursor advances only after a final transcript is saved. */
export class LiveTranscription {
  private readonly store: SegmentStore & CheckpointStore;
  private socket?: WebSocket;
  private epoch = 0;
  private desired = false;
  private ending = false;
  private ready = false;
  private loaded = false;
  private loading?: Promise<void>;
  private state: LiveState = "idle";
  private checkpoint = empty();
  private entries: Entry[] = [];
  private head = 0;
  private position = 0;
  private catchupUntil = 0;
  private cutoverTime = 0;
  private preRoll: Array<{ samples: Int16Array; start: number }> = [];
  private turn?: Turn;
  private awaiting = false;
  private finalizing = false;
  private saving: Promise<void> = Promise.resolve();
  private lastSpeechAt = 0;
  private lastFinalAt = -Infinity;
  private pumping = false;
  private attempt = 0;
  private rotate = false;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private rotation?: ReturnType<typeof setTimeout>;
  private pumpingAgain = false;
  private speechPending = false;
  private completedIds = new Set<string>();
  constructor(private readonly meetingId: string, private readonly onResult: (result: TranscriptResult) => void,
    private readonly onState: (state: LiveState) => void, private readonly options: Options = {}) {
    this.store = options.store ?? new IndexedDbSegmentStore();
  }
  get unsettled() { return this.state !== "live" || this.speechPending || !!this.turn || this.awaiting || this.head - this.position > FRAME * 3; }
  get progress() { return { processedMs: this.checkpoint.cursor * 1000 / SAMPLE_RATE, availableMs: this.head * 1000 / SAMPLE_RATE }; }
  // Audio activity can hold back Kneut before the next two-second backup has been saved.
  noteSpeech() { this.speechPending = true; this.lastSpeechAt = Date.now(); }
  async start() {
    this.desired = true; this.ending = false;
    if (this.socket || this.retry) return;
    if (this.loading) {
      await this.loading.catch(()=>undefined);
      if(this.desired && !this.socket && !this.retry)await this.start();
      return;
    }
    const epoch = ++this.epoch;
    this.emit("connecting");
    this.loading = this.load();
    try { await this.loading; }
    catch { if (epoch === this.epoch) { this.blocked("Live herstel is niet beschikbaar. De lokale opname blijft apart bewaard; gebruik de controle na afloop."); } return; }
    finally { this.loading = undefined; }
    if (epoch !== this.epoch || !this.desired) return;
    await this.connect(epoch);
  }
  private async load() {
    if (this.loaded) return;
    const [saved, segments] = await Promise.all([this.store.loadMeeting(this.meetingId), this.store.list(this.meetingId)]);
    this.entries = [];
    for (const segment of segments.sort((a,b) => a.sequence-b.sequence)) this.addEntry(segment);
    const live = saved?.live;
    if (live) {
      if (live.version !== 1 || !Number.isSafeInteger(live.cursor) || live.cursor < 0 || live.cursor > this.head
        || !Number.isSafeInteger(live.nextSequence) || live.nextSequence < 1_000_000 || !Array.isArray(live.turns)
        || live.turns.some(t => t.meetingId !== this.meetingId || !t.liveFinal || typeof t.text !== "string" || t.sequence>=live.nextSequence
          || !Number.isSafeInteger(t.audioStartSample) || !Number.isSafeInteger(t.audioEndSample) || t.audioEndSample!>live.cursor || t.audioStartSample!<0 || t.audioStartSample!>=t.audioEndSample!)) throw new Error("Ongeldige live herstelgegevens.");
      this.checkpoint = live;
    }
    this.position = this.checkpoint.cursor;
    this.catchupUntil = this.head;
    this.options.onRestore?.(this.checkpoint.turns.map(t => ({...t, replayed: true})));
    this.loaded = true;
  }
  notifySavedAudio(segment: LocalSegment) {
    if (segment.meetingId !== this.meetingId) return;
    // A load in progress reads the database; append any just-saved segment afterwards as well.
    if (this.loading) { void this.loading.then(() => this.notifySavedAudio(segment)).catch(() => undefined); return; }
    if (!this.loaded) return;
    try { this.addEntry(segment); }
    catch { this.blocked("Live audio sluit niet aan. Gebruik de controle na afloop; bestaande audio blijft bewaard."); return; }
    void this.pump();
  }
  private addEntry(segment: LocalSegment) {
    if (segment.sequence <= this.entries.length) return;
    if (segment.sequence !== this.entries.length + 1 || segment.blob.type !== "audio/wav") throw new Error("Audio ontbreekt of vereist verwerking na afloop.");
    const length = (segment.blob.size - 44) / 2;
    if (!Number.isInteger(length) || length <= 0 || Math.abs(length / 24 - segment.durationMs) > 1) throw new Error("Ongeldig audioblok.");
    const start = this.entries.at(-1)?.end ?? 0;
    if (segment.startMs !== undefined && Math.abs(segment.startMs * 24 - start) > 1) throw new Error("Audio sluit niet aan.");
    this.entries.push({ segment, start, end: start + length }); this.head = start + length;
  }
  private async connect(epoch: number) {
    if (!this.desired || epoch !== this.epoch) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) { this.failed(epoch); return; }
    await this.saving.catch(()=>undefined);
    if (!this.desired || epoch !== this.epoch) return;
    this.position = this.checkpoint.cursor;
    this.options.onRestore?.(this.checkpoint.turns.map(t=>({...t,replayed:true})));
    this.emit("connecting");
    this.watchdog = setTimeout(() => this.failed(epoch), 30000);
    try {
      const {data: token} = await createToken({meetingId:this.meetingId});
      if (epoch !== this.epoch || !this.desired) return;
      if (!token.value.startsWith("ek_") || token.expiresAt*1000 <= Date.now()) throw new Error("expired");
      const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime",`openai-insecure-api-key.${token.value}`]);
      this.socket = socket;
      socket.onmessage = ({data}) => { if(epoch !== this.epoch)return; try { this.event(JSON.parse(data), epoch); } catch { this.failed(epoch); } };
      socket.onerror = socket.onclose = () => this.failed(epoch);
    } catch { this.failed(epoch); }
  }
  private emit(state: LiveState) { if (this.state !== state) { this.state = state; this.onState(state); } }
  private send(event: Record<string,unknown>) {
    try {
      if (this.socket?.readyState !== 1) throw new Error("Live verbinding gesloten.");
      this.socket.send(JSON.stringify(event));
    } catch (cause) { this.failed(this.epoch); throw cause; }
  }
  private append(samples: Int16Array) {
    const bytes = new Uint8Array(samples.length*2);const view = new DataView(bytes.buffer);
    samples.forEach((sample,i)=>view.setInt16(i*2,sample,true));
    let binary = "";for(let i=0;i<bytes.length;i+=16000)binary+=String.fromCharCode(...bytes.subarray(i,i+16000));
    this.send({type:"input_audio_buffer.append",audio:btoa(binary)});
  }
  private async pump() {
    if (this.pumping) { this.pumpingAgain = true; return; }
    if (!this.ready || this.awaiting) return;
    this.pumping = true; const epoch = this.epoch; let bufferWaitStarted = 0;
    try {
      while(this.ready && epoch === this.epoch && !this.awaiting && this.position < this.head) {
        if ((this.socket?.bufferedAmount ?? 0) > 256000) {
          // Backpressure never drops frames: the unsent source remains in IndexedDB.
          if (!bufferWaitStarted) bufferWaitStarted = Date.now();
          if (Date.now()-bufferWaitStarted > 15000) { this.failed(epoch); return; }
          await new Promise(r => setTimeout(r, 100));
          if ((this.socket?.bufferedAmount ?? 0) > 1000000) { this.failed(epoch); return; }
          continue;
        }
        bufferWaitStarted = 0;
        const entry = this.entries.find(e => e.end > this.position);
        if (!entry || entry.start > this.position) throw new Error("Audio ontbreekt.");
        await verifySegment(entry.segment);
        const samples = await readWav(entry.segment.blob);
        if (epoch !== this.epoch || !this.ready) return;
        for (let offset = this.position-entry.start; offset < samples.length;) {
          const frame = samples.slice(offset, Math.min(offset+FRAME,samples.length));
          const start = entry.start+offset; offset += frame.length;this.position = start+frame.length;
          const rms = Math.sqrt(frame.reduce((n,s)=>n+(s/32768)**2,0)/frame.length);
          if (!this.turn) {
            this.preRoll.push({samples:frame,start});if(this.preRoll.length>3)this.preRoll.shift();
            if(rms < .008) continue;
            this.turn = {sequence:this.checkpoint.nextSequence,start:this.preRoll[0].start,end:this.position,silence:0,
              replayed:start<this.catchupUntil || entry.segment.createdAt-(entry.end-start)/24<this.cutoverTime,text:""};
            for(const part of this.preRoll)this.append(part.samples);this.preRoll=[];
          } else { this.append(frame);this.turn.end=this.position; }
          this.turn.silence = rms<.008 ? this.turn.silence+frame.length : 0;
          if (this.turn.silence >= .9*SAMPLE_RATE || this.turn.end-this.turn.start >= 60*SAMPLE_RATE) {
            this.commit(); return;
          }
        }
      }
      if(epoch !== this.epoch || !this.ready)return;
      if(this.ending && this.turn) { this.commit(); return; }
      if(!this.turn) {
        const cursor = this.preRoll[0]?.start ?? this.position;
        if(cursor > this.checkpoint.cursor) await this.save({...this.checkpoint,cursor});
        if(epoch !== this.epoch)return;
        if ((this.entries.at(-1)?.segment.createdAt ?? 0) >= this.lastSpeechAt) this.speechPending = false;
        if(this.rotate && this.desired) { this.tryRotation(); if(!this.ready)return; }
      }
      this.emit(this.checkpoint.cursor < this.catchupUntil || this.head-this.position > 3*SAMPLE_RATE ? "recovering" : "live");
    } catch { if(epoch === this.epoch) { this.blocked("Live verwerking kon de lokale audio niet lezen of het herstelpunt niet opslaan. De opname blijft apart beschikbaar."); } }
    finally {
      this.pumping = false;
      if(this.pumpingAgain) { this.pumpingAgain=false; void this.pump(); }
    }
  }
  private commit() {
    if(!this.turn || this.awaiting)return;
    this.awaiting = true;
    this.send({type:"input_audio_buffer.commit"});
    clearTimeout(this.watchdog);const epoch=this.epoch;
    this.watchdog=setTimeout(()=>this.failed(epoch),45000);
    this.emit(this.turn.replayed ? "recovering" : "live");
  }
  private event(event: Record<string,any>, epoch: number) {
    if(event.type === "error") { this.failed(epoch); return; }
    if(["session.created","session.updated","transcription_session.created"].includes(event.type)) {
      if(this.ready)return;
      clearTimeout(this.watchdog);this.ready=true;this.attempt=0;this.cutoverTime=Date.now();
      this.rotation=setTimeout(()=>{this.rotate=true;this.tryRotation();},this.options.rotationMs ?? 20*60*1000);
      this.emit(this.position<this.catchupUntil ? "recovering" : "live");void this.pump();return;
    }
    const turn=this.turn,id=event.item_id;
    if(!turn || typeof id!=="string" || this.completedIds.has(id))return;
    if(event.type === "input_audio_buffer.committed") { turn.itemId=id;return; }
    if(!event.type.startsWith("conversation.item.input_audio_transcription."))return;
    if(turn.itemId && turn.itemId !== id)return;
    if(event.type.endsWith("failed")) { this.failed(epoch);return; }
    if(!event.type.endsWith("delta") && !event.type.endsWith("completed"))return;
    turn.itemId=id;
    const final=event.type.endsWith("completed");
    turn.text=final?String(event.transcript??""):turn.text+String(event.delta??"");
    const result:TranscriptResult={meetingId:this.meetingId,sequence:turn.sequence,text:turn.text,model:"gpt-live-transcribe",provisional:true,
      liveFinal:final,replayed:turn.replayed,audioStartSample:turn.start,audioEndSample:turn.end};
    if(!final) {this.onResult(result);return;}
    if(!this.awaiting || this.finalizing)return;
    this.finalizing=true;
    clearTimeout(this.watchdog);
    const checkpoint={...this.checkpoint,cursor:turn.end,nextSequence:turn.sequence+1,turns:[...this.checkpoint.turns,result]};
    // Hold the queue until the final text AND cursor are committed in the same local transaction.
    void this.save(checkpoint).then(()=>{
      if(epoch!==this.epoch)return;
      this.completedIds.add(id);if(this.completedIds.size>100)this.completedIds.delete(this.completedIds.values().next().value!);
      this.lastFinalAt=Date.now();this.onResult(result);this.turn=undefined;this.awaiting=false;this.finalizing=false;this.preRoll=[];
      void this.pump();
    }).catch(()=>{if(epoch===this.epoch){this.blocked("Live tekst kon niet lokaal worden vastgelegd. De audio blijft beschikbaar; herstel de opslag of gebruik de controle na afloop.");}});
  }
  private save(checkpoint:LiveCheckpoint) {
    this.saving = this.saving.catch(()=>undefined).then(async()=>{
      await this.store.saveMeeting(this.meetingId,{live:checkpoint});this.checkpoint=checkpoint;
    });
    return this.saving;
  }
  private drop(rollback=true) {
    ++this.epoch;clearTimeout(this.watchdog);clearTimeout(this.rotation);
    this.socket?.close();this.socket=undefined;this.ready=false;this.turn=undefined;this.awaiting=false;this.finalizing=false;this.preRoll=[];this.rotate=false;
    if(rollback)this.position=this.checkpoint.cursor;
  }
  private tryRotation() {
    clearTimeout(this.rotation);
    if(!this.desired || !this.rotate)return;
    // Give the meeting controller time to consume a fresh wake word before changing transport.
    if(!this.turn && !this.awaiting && !this.speechPending && Date.now()-Math.max(this.lastSpeechAt,this.lastFinalAt)>=5000) {this.renew();return;}
    this.rotation=setTimeout(()=>this.tryRotation(),1000);
  }
  private renew() {
    this.drop();this.catchupUntil=this.head;
    if(this.desired)void this.connect(this.epoch);
  }
  private blocked(message:string) {
    this.desired=false;this.drop(false);this.emit("blocked");this.options.onIssue?.(message);
  }
  private failed(epoch:number) {
    if(epoch!==this.epoch)return;
    this.drop();this.catchupUntil=this.head;this.emit("offline");
    if(!this.desired)return;
    const delay=this.options.retryDelay?.(this.attempt) ?? Math.min(30000,1000*2**Math.min(this.attempt,5))*(.85+Math.random()*.3);
    this.attempt++;
    this.retry=setTimeout(()=>{this.retry=undefined;if(this.desired)void this.connect(this.epoch);},delay);
  }
  reconnect() { this.desired=true;clearTimeout(this.retry);this.retry=undefined;this.drop();this.catchupUntil=this.head;void this.start(); }
  async finish() {
    this.ending=true;this.desired=false;clearTimeout(this.retry);this.retry=undefined;clearTimeout(this.rotation);
    void this.pump();
    const until=Date.now()+2000;
    while(this.ready && (this.awaiting || this.turn || this.pumping || this.head-this.position>FRAME*3) && Date.now()<until) await new Promise(r=>setTimeout(r,50));
    this.close();
  }
  close() {this.desired=false;this.ending=false;clearTimeout(this.retry);this.retry=undefined;this.drop();this.emit("idle");}
}
