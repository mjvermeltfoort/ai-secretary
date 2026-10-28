import { registerLocalSegment, type RecordingState } from "../domain/recording";
import {
  IndexedDbSegmentStore,
  type LocalSegment,
  type SegmentStore,
} from "./localSegmentStore";

export interface BrowserRecorderOptions {
  segmentDurationMs?: number;
  store?: SegmentStore;
  onSegment?: (segment: LocalSegment) => void;
  onError?: (error: Error) => void;
}

export class BrowserRecorder {
  private readonly segmentDurationMs: number;
  private readonly store: SegmentStore;
  private readonly onSegment?: (segment: LocalSegment) => void;
  private readonly onError?: (error: Error) => void;
  private mediaRecorder?: MediaRecorder;
  private stream?: MediaStream;
  private meetingId?: string;
  private chunks: Blob[] = [];
  private segmentTimer?: ReturnType<typeof setTimeout>;
  private segmentOperation: Promise<void> = Promise.resolve();
  private stopping = false;
  private state: RecordingState = {
    status: "ready",
    nextSequence: 1,
    localSequences: [],
    uploadedSequences: [],
  };

  constructor(options: BrowserRecorderOptions = {}) {
    this.segmentDurationMs = options.segmentDurationMs ?? 15_000;
    this.store = options.store ?? new IndexedDbSegmentStore();
    this.onSegment = options.onSegment;
    this.onError = options.onError;
  }

  get recordingState(): RecordingState {
    return this.state;
  }

  async start(meetingId: string): Promise<void> {
    if (this.mediaRecorder?.state === "paused") {
      this.stopping = false;
      this.mediaRecorder.resume();
      this.state = { ...this.state, status: "recording" };
      this.scheduleSegmentRotation();
      return;
    }

    if (this.mediaRecorder?.state === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("Deze browser ondersteunt geen lokale audio-opname.");
    }

    this.meetingId = meetingId;
    this.stopping = false;
    const existing = await this.store.list(meetingId);
    this.state = existing.reduce<RecordingState>(
      (current, segment) => registerLocalSegment(current, segment.sequence),
      { ...this.state, status: "ready" },
    );
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.createRecorder();
    this.scheduleSegmentRotation();
    this.state = { ...this.state, status: "recording" };
  }

  pause(): void {
    if (this.mediaRecorder?.state !== "recording") return;
    this.clearSegmentTimer();
    this.mediaRecorder.pause();
    this.state = { ...this.state, status: "paused" };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearSegmentTimer();
    try {
      await this.enqueueSegmentOperation(() => this.finishCurrentSegment());
    } catch (cause) {
      this.onError?.(cause instanceof Error ? cause : new Error("Audiosegment kon niet worden opgeslagen."));
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.mediaRecorder = undefined;
    this.state = { ...this.state, status: "stopped" };
  }

  private createRecorder(): void {
    if (!this.stream) return;

    const mimeType = this.supportedMimeType();
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.chunks = [];
    this.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.mediaRecorder.addEventListener("error", () => {
      this.onError?.(new Error("Audio-opname gaf een fout."));
    });
    this.mediaRecorder.start();
  }

  private scheduleSegmentRotation(): void {
    this.clearSegmentTimer();
    this.segmentTimer = setTimeout(() => {
      void this.enqueueSegmentOperation(() => this.rotateSegment()).catch((cause) => {
        this.onError?.(cause instanceof Error ? cause : new Error("Audiosegment kon niet worden opgeslagen."));
      });
    }, this.segmentDurationMs);
  }

  private clearSegmentTimer(): void {
    if (this.segmentTimer) clearTimeout(this.segmentTimer);
    this.segmentTimer = undefined;
  }

  private enqueueSegmentOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.segmentOperation.then(operation, operation);
    this.segmentOperation = next.catch(() => undefined);
    return next;
  }

  private async rotateSegment(): Promise<void> {
    this.clearSegmentTimer();
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state !== "recording") return;

    const blob = await this.stopRecorder(recorder);
    this.mediaRecorder = undefined;
    await this.persist(blob);

    if (!this.stopping && this.state.status === "recording" && this.stream) {
      this.createRecorder();
      this.scheduleSegmentRotation();
    }
  }

  private async finishCurrentSegment(): Promise<void> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === "inactive") return;

    const blob = await this.stopRecorder(recorder);
    this.mediaRecorder = undefined;
    await this.persist(blob);
  }

  private stopRecorder(recorder: MediaRecorder): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const onStop = () => {
        cleanup();
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.chunks = [];
        resolve(blob);
      };
      const onError = () => {
        cleanup();
        reject(new Error("Audio-opname kon niet worden afgesloten."));
      };
      const cleanup = () => {
        recorder.removeEventListener("stop", onStop);
        recorder.removeEventListener("error", onError);
      };

      recorder.addEventListener("stop", onStop, { once: true });
      recorder.addEventListener("error", onError, { once: true });
      recorder.stop();
    });
  }

  private async persist(blob: Blob): Promise<void> {
    if (!this.meetingId || blob.size === 0) return;

    const sequence = this.state.nextSequence;
    this.state = { ...this.state, nextSequence: sequence + 1 };
    const segment: LocalSegment = {
      id: `${this.meetingId}-${sequence}`,
      meetingId: this.meetingId,
      sequence,
      createdAt: Date.now(),
      durationMs: this.segmentDurationMs,
      blob,
      transcriptionStatus: "pending",
    };

    await this.store.put(segment);
    this.state = registerLocalSegment(this.state, sequence);
    this.onSegment?.(segment);
  }

  private supportedMimeType(): string {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
  }
}
