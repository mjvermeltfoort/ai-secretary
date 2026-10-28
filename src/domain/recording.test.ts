import { describe, expect, it } from "vitest";
import {
  buildRecoveryPlan,
  registerLocalSegment,
  rotateSession,
  type RecordingState,
} from "./recording";

describe("recording recovery", () => {
  it("finds local segments missing after a connection failure", () => {
    const plan = buildRecoveryPlan({
      status: "recovering",
      nextSequence: 5,
      localSequences: [1, 2, 3, 4],
      uploadedSequences: [1, 3],
    });

    expect(plan.missingSequences).toEqual([2, 4]);
    expect(plan.canResume).toBe(true);
  });

  it("keeps long recordings resumable across session rotation", () => {
    let state: RecordingState = {
      status: "recording" as const,
      nextSequence: 10_001,
      localSequences: Array.from({ length: 10_000 }, (_, index) => index + 1),
      uploadedSequences: Array.from({ length: 9_999 }, (_, index) => index + 1),
    };

    state = rotateSession(state);
    expect(state.nextSequence).toBe(10_002);
    expect(buildRecoveryPlan(state).missingSequences).toEqual([10_000]);
  });

  it("does not retry a segment that the cloud acknowledged", () => {
    const plan = buildRecoveryPlan({
      status: "ready",
      nextSequence: 3,
      localSequences: [1, 2],
      uploadedSequences: [1, 2],
    });

    expect(plan.missingSequences).toEqual([]);
    expect(plan.canResume).toBe(false);
  });

  it("registers each local segment once and advances the sequence", () => {
    const state = registerLocalSegment(
      registerLocalSegment(initialRecordingState(), 3),
      3,
    );

    expect(state.localSequences).toEqual([3]);
    expect(state.nextSequence).toBe(4);
  });
});

function initialRecordingState(): RecordingState {
  return {
    status: "recording",
    nextSequence: 1,
    localSequences: [],
    uploadedSequences: [],
  };
}
