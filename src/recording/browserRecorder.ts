import { registerLocalSegment, type RecordingState } from "../domain/recording";
import { IndexedDbSegmentStore, type LocalSegment, type SegmentStore } from "./localSegmentStore";
import { sha256 } from "./exportRecording";
import { pcm16, PcmSegmenter, SAMPLE_RATE, wav } from "./pcm";
export interface BrowserRecorderOptions {
  segmentDurationMs?: number; store?: SegmentStore;
  onSegment?: (segment: LocalSegment) => void; onError?: (error: Error) => void;
  onAudio?: (samples: Int16Array) => void;
}
export class BrowserRecorder {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private mute?: GainNode;
  private segmenter?: PcmSegmenter;
  private meetingId = "";
  private offsetMs = 0;
  private saving: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;
  private generation = 0;
  private starting = false;
  private flushId = 0;
  private flushes = new Map<number, () => void>();
  private state: RecordingState = { status: "ready", nextSequence: 1, localSequences: [], uploadedSequences: [] };
  constructor(private readonly options: BrowserRecorderOptions = {}) {}
  private get store() { return this.options.store ?? (this.options.store = new IndexedDbSegmentStore()); }
  get recordingState() { return this.state; }
  cloneMicrophone(): MediaStream | undefined { return this.stream?.clone(); }
  async start(meetingId: string): Promise<void> {
    if (this.state.status === "recording" || this.starting) return;
    await this.stopping;
    if (this.context && this.state.status === "paused" && meetingId === this.meetingId) {
      await this.context.resume(); this.node?.port.postMessage({ type: "resume" }); this.state = { ...this.state, status: "recording" }; return;
    }
    const generation = ++this.generation; this.starting = true;
    try {
      this.saving = Promise.resolve();
      this.meetingId = meetingId;
      const existing = await this.store.list(meetingId);
      if (generation !== this.generation) return;
      this.offsetMs = existing.reduce((total, s) => total + s.durationMs, 0);
      this.state = existing.reduce((s, item) => registerLocalSegment(s, item.sequence), { status: "ready", nextSequence: 1, localSequences: [], uploadedSequences: [] } as RecordingState);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        void this.stop().catch(()=>undefined).finally(() => this.options.onError?.(new Error("De microfoon is gestopt. De eerder opgeslagen audio blijft beschikbaar; hervat de vergadering om verder op te nemen.")));
      }));
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const context = this.context;
      context.addEventListener("statechange", () => {
        if (this.context !== context || this.state.status !== "recording" || this.stopping) return;
        if (context.state === "suspended" || context.state === "closed") {
          void this.stop().catch(()=>undefined).finally(()=>this.options.onError?.(new Error("De browser heeft de opname onderbroken. Hervat de vergadering; de al bewaarde audio blijft beschikbaar.")));
        }
      });
      if (this.context.sampleRate !== SAMPLE_RATE) throw new Error("Deze browser ondersteunt de vereiste opnamesnelheid niet.");
      await this.context.audioWorklet.addModule("/pcm-recorder-worklet.js");
      if (generation !== this.generation) return;
      this.segmenter = new PcmSegmenter(Math.round(SAMPLE_RATE * (this.options.segmentDurationMs ?? 2000) / 1000), samples => this.persist(samples));
      this.source = this.context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.context, "pcm-recorder");
      this.node.port.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        if (data.type === "flushed") { this.flushes.get(data.id)?.(); this.flushes.delete(data.id); return; }
        if (data.type !== "samples") return;
        const samples = pcm16(data.samples);
        this.segmenter?.push(samples);
        try { this.options.onAudio?.(samples); } catch { /* AI failures never interrupt local storage. */ }
      };
      this.mute = this.context.createGain(); this.mute.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.mute); this.mute.connect(this.context.destination);
      this.state = { ...this.state, status: "recording" }; await this.context.resume();
    } catch (cause) { await this.release(); throw cause; }
    finally { this.starting = false; }
  }
  async pause(): Promise<void> {
    if (this.state.status !== "recording") return;
    await this.flush("pause");
    this.segmenter?.flush(); await this.saving;
    this.state = { ...this.state, status: "paused" };
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.starting) { await this.release(); this.state={...this.state,status:"stopped"}; return; }
      try {
        let flushError: unknown;
        try { await this.flush("pause"); } catch(cause) { flushError=cause; }
        this.segmenter?.flush(); await this.saving;
        if(flushError)throw flushError;
      } finally { await this.release(); this.state = { ...this.state, status: "stopped" }; }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async flush(type: "flush" | "pause" = "flush") {
    if (!this.node) return;
    const id = ++this.flushId;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.flushes.delete(id); reject(new Error("De laatste audio kon niet worden veiliggesteld. De eerdere lokale audio blijft bewaard.")); }, 3000);
      this.flushes.set(id, () => { clearTimeout(timer); resolve(); });
      this.node!.port.postMessage({ type, id });
    });
  }
  private persist(samples: Int16Array) {
    const sequence = this.state.nextSequence;
    const durationMs = samples.length * 1000 / SAMPLE_RATE;
    const segment: LocalSegment = { id: `${this.meetingId}-${sequence}`, meetingId: this.meetingId, sequence, createdAt: Date.now(), durationMs, startMs: this.offsetMs, blob: wav(samples), transcriptionStatus: "pending" };
    this.offsetMs += durationMs; this.state = { ...this.state, nextSequence: sequence + 1 };
    this.saving = this.saving.then(async () => {
      segment.checksum = await sha256(segment.blob);
      if(this.store.append)await this.store.append(segment);else await this.store.put(segment);
      this.state = registerLocalSegment(this.state, sequence); this.options.onSegment?.(segment);
    });
    void this.saving.catch((cause) => {
      this.state = { ...this.state, status: "stopped" }; void this.release();
      this.options.onError?.(cause instanceof Error ? cause : new Error("Lokale opslag mislukt."));
    });
  }
  private async release() {
    ++this.generation;
    const source=this.source, node=this.node, mute=this.mute, stream=this.stream, context=this.context;
    this.context=undefined;this.stream=undefined;this.node=undefined;this.source=undefined;this.mute=undefined;
    source?.disconnect();node?.disconnect();mute?.disconnect();
    stream?.getTracks().forEach(t=>t.stop());
    await context?.close().catch(()=>undefined);
  }
}
