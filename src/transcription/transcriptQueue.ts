import type { LocalSegment, SegmentStore } from "../recording/localSegmentStore";
import type { TranscriptResult } from "./transcriptionClient";

export interface QueueSnapshot {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  lastError?: string;
}

interface TranscriptQueueOptions {
  store: SegmentStore;
  transcribe: (segment: LocalSegment) => Promise<TranscriptResult>;
  onSnapshot?: (snapshot: QueueSnapshot, meetingId: string) => void;
  onResult?: (result: TranscriptResult) => void;
}

export class TranscriptQueue {
  private readonly store: SegmentStore;
  private readonly transcribe: TranscriptQueueOptions["transcribe"];
  private readonly onSnapshot?: TranscriptQueueOptions["onSnapshot"];
  private readonly onResult?: TranscriptQueueOptions["onResult"];
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();

  constructor(options: TranscriptQueueOptions) {
    this.store = options.store;
    this.transcribe = options.transcribe;
    this.onSnapshot = options.onSnapshot;
    this.onResult = options.onResult;
  }

  async process(meetingId: string): Promise<void> {
    const active = this.running.get(meetingId);
    if (active) {
      this.rerun.add(meetingId);
      return active;
    }

    const run = this.drain(meetingId);
    this.running.set(meetingId, run);
    try {
      await run;
    } finally {
      this.running.delete(meetingId);
    }
  }

  private async drain(meetingId: string): Promise<void> {
    do {
      this.rerun.delete(meetingId);
      const segments = await this.store.list(meetingId);

      for (const original of segments) {
        const segment = normalizeSegment(original);
        if (segment.transcriptionStatus === "completed") continue;

        await this.store.put({ ...segment, transcriptionStatus: "processing", transcriptionError: undefined });
        this.publish(meetingId, await this.store.list(meetingId));

        try {
          const result = await this.transcribe(segment);
          await this.store.put({ ...segment, transcriptionStatus: "completed", transcriptionError: undefined });
          this.onResult?.(result);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Transcriptie mislukt.";
          await this.store.put({ ...segment, transcriptionStatus: "failed", transcriptionError: message });
        }

        this.publish(meetingId, await this.store.list(meetingId));
      }
    } while (this.rerun.has(meetingId));
  }

  private publish(meetingId: string, segments: LocalSegment[]): void {
    if (!segments.some((segment) => segment.meetingId === meetingId)) return;
    const snapshot = segments.reduce<QueueSnapshot>((state, segment) => {
      const status = segment.transcriptionStatus ?? "pending";
      state[status] += 1;
      if (segment.transcriptionError) state.lastError = segment.transcriptionError;
      return state;
    }, { pending: 0, processing: 0, completed: 0, failed: 0 });
    this.onSnapshot?.(snapshot, meetingId);
  }
}

function normalizeSegment(segment: LocalSegment): LocalSegment {
  return {
    ...segment,
    transcriptionStatus: segment.transcriptionStatus === "processing" ? "pending" : segment.transcriptionStatus ?? "pending",
  };
}
