import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { TranscriptResult } from "./transcriptionClient";
const createToken = httpsCallable<{ meetingId: string }, { value: string; expiresAt: number }>(functions, "createTranscriptionSession");
export type LiveState = "idle" | "connecting" | "live" | "offline";
export class LiveTranscription {
  private socket?: WebSocket;
  private epoch = 0;
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Int16Array[] = [];
  private order = new Map<string, number>();
  private texts = new Map<string, string>();
  private nextSequence = 1_000_000;
  private talking = false;
  private silenceMs = 0;
  private turnMs = 0;
  private preRoll: Int16Array[] = [];
  private pendingCommits = 0;
  private expected = new Set<string>();
  constructor(private readonly meetingId: string, private readonly onResult: (result: TranscriptResult) => void, private readonly onState: (state: LiveState) => void) {}
  get unsettled() { return this.talking || this.pendingCommits > 0 || this.expected.size > 0; }
  async start() {
    if (this.socket || this.ready) return;
    const epoch = ++this.epoch; this.onState("connecting"); this.pending = [];
    this.timer = setTimeout(()=>this.fail(),30000);
    try {
      const { data: token } = await createToken({ meetingId: this.meetingId });
      if (epoch !== this.epoch) return;
      if (!token.value.startsWith("ek_") || token.expiresAt * 1000 < Date.now()) throw new Error("expired");
      const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime",`openai-insecure-api-key.${token.value}`]);
      this.socket = socket;
      socket.onmessage = ({ data }) => { if(epoch!==this.epoch)return; try { this.event(JSON.parse(data)); } catch { this.fail(); } };
      socket.onerror = socket.onclose = () => { if(epoch===this.epoch)this.fail(); };
    } catch { if(epoch===this.epoch)this.fail(); }
  }
  push(samples: Int16Array) {
    if (!this.ready) { if(this.timer) { this.pending.push(samples.slice()); if(this.pending.length>100)this.pending.shift(); } return; }
    if ((this.socket?.bufferedAmount ?? 0) > 1_000_000) { this.fail(); return; }
    const ms = samples.length/24;
    const rms = Math.sqrt(samples.reduce((total,s)=>total+(s/32768)**2,0)/Math.max(1,samples.length));
    if (!this.talking) {
      this.preRoll.push(samples); if(this.preRoll.length>3)this.preRoll.shift();
      if(rms<0.008)return;
      this.talking = true; this.turnMs=0; this.silenceMs=0;
      for(const frame of this.preRoll)this.append(frame);
      this.preRoll=[];
    } else this.append(samples);
    this.turnMs+=ms; this.silenceMs = rms<0.008 ? this.silenceMs+ms : 0;
    if(this.silenceMs>=900 || this.turnMs>=60000)this.commit();
  }
  commit() { if(this.talking) { this.send({type:"input_audio_buffer.commit"}); this.pendingCommits++; this.talking=false; this.silenceMs=0; this.turnMs=0; this.preRoll=[]; } }
  async finish() {
    this.commit();
    const until = Date.now()+2000;
    while(this.ready && (this.expected.size || this.pendingCommits) && Date.now()<until)await new Promise(r=>setTimeout(r,50));
    this.close();
  }
  close() {
    ++this.epoch; clearTimeout(this.timer); this.timer=undefined;
    this.socket?.close(); this.socket=undefined; this.ready=false;
    this.pending=[]; this.preRoll=[]; this.talking=false; this.expected.clear(); this.pendingCommits=0; this.onState("idle");
  }
  private fail() { this.close(); this.onState("offline"); }
  private send(event: Record<string,unknown>) { if(this.socket?.readyState===1)this.socket.send(JSON.stringify(event)); }
  private append(samples: Int16Array) {
    const bytes = new Uint8Array(samples.length*2); const view = new DataView(bytes.buffer);
    samples.forEach((sample,i)=>view.setInt16(i*2,sample,true));
    let binary="";for(let i=0;i<bytes.length;i+=16000)binary+=String.fromCharCode(...bytes.subarray(i,i+16000));
    this.send({type:"input_audio_buffer.append",audio:btoa(binary)});
  }
  private event(event: Record<string,any>) {
    if(event.type==="error") { this.fail(); return; }
    if(event.type==="session.created" || event.type==="session.updated" || event.type==="transcription_session.created") {
      if(this.ready)return;
      clearTimeout(this.timer); this.timer=undefined; this.ready=true; this.onState("live");
      const pending=this.pending;this.pending=[];for(const frame of pending)this.push(frame);
    }
    const id=event.item_id;
    if(event.type==="input_audio_buffer.committed" && typeof id==="string") { if(!this.order.has(id))this.order.set(id,this.nextSequence++); this.expected.add(id); this.pendingCommits=Math.max(0,this.pendingCommits-1); }
    if((event.type==="conversation.item.input_audio_transcription.delta" || event.type==="conversation.item.input_audio_transcription.completed") && typeof id==="string") {
      if(!this.order.has(id))this.order.set(id,this.nextSequence++);
      const final=event.type.endsWith("completed");
      const text=final?String(event.transcript??""):(this.texts.get(id)??"")+String(event.delta??"");this.texts.set(id,text);
      if(final)this.expected.delete(id);
      this.onResult({meetingId:this.meetingId,sequence:this.order.get(id)!,text,model:"gpt-live-transcribe",provisional:true,liveFinal:final});
      // Finished paragraphs remain in React state, not in an unbounded audio buffer.
      if(final)this.texts.delete(id);
    }
    if(event.type==="conversation.item.input_audio_transcription.failed")this.fail();
  }
}
