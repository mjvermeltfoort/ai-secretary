import { describe, expect, it } from "vitest";
import type { LocalSegment, SegmentStore } from "../recording/localSegmentStore";
import { TranscriptQueue } from "./transcriptQueue";

class MemorySegmentStore implements SegmentStore {
  private readonly segments = new Map<string, LocalSegment>();

  async list(meetingId: string): Promise<LocalSegment[]> {
    return [...this.segments.values()].filter((segment) => segment.meetingId === meetingId);
  }

  async put(segment: LocalSegment): Promise<void> {
    this.segments.set(segment.id, segment);
  }
}

function segment(sequence: number, status?: LocalSegment["transcriptionStatus"]): LocalSegment {
  return {
    id: `meeting-${sequence}`,
    meetingId: "meeting",
    sequence,
    createdAt: Date.now(),
    durationMs: 15_000,
    blob: new Blob(["audio"], { type: "audio/webm" }),
    transcriptionStatus: status,
  };
}

describe("transcript queue", () => {
  it("processes pending segments once and reports results", async () => {
    const store = new MemorySegmentStore();
    await store.put(segment(1));
    const results: number[] = [];
    const queue = new TranscriptQueue({
      store,
      transcribe: async (item) => ({ meetingId: item.meetingId, sequence: item.sequence, text: "Hallo", model: "test" }),
      onResult: (result) => results.push(result.sequence),
    });

    await queue.process("meeting");
    await queue.process("meeting");

    expect(results).toEqual([1]);
    expect((await store.list("meeting"))[0].transcriptionStatus).toBe("completed");
  });

  it("keeps failures for retry and recovers processing after restart", async () => {
    const store = new MemorySegmentStore();
    await store.put(segment(1, "processing"));
    let attempts = 0;
    const queue = new TranscriptQueue({
      store,
      transcribe: async (item) => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return { meetingId: item.meetingId, sequence: item.sequence, text: "Hersteld", model: "test" };
      },
    });

    await queue.process("meeting");
    expect((await store.list("meeting"))[0].transcriptionStatus).toBe("failed");
    await queue.process("meeting");
    expect((await store.list("meeting"))[0].transcriptionStatus).toBe("completed");
  });
});
