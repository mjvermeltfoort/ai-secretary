export type RecordingStatus = "ready" | "recording" | "paused" | "recovering" | "stopped";

export interface RecordingState {
  status: RecordingStatus;
  nextSequence: number;
  uploadedSequences: number[];
  localSequences: number[];
}

export interface RecoveryPlan {
  missingSequences: number[];
  canResume: boolean;
}

export function registerLocalSegment(state: RecordingState, sequence: number): RecordingState {
  if (state.localSequences.includes(sequence)) return state;

  return {
    ...state,
    localSequences: [...state.localSequences, sequence].sort((a, b) => a - b),
    nextSequence: Math.max(state.nextSequence, sequence + 1),
  };
}

export function buildRecoveryPlan(state: RecordingState): RecoveryPlan {
  const local = new Set(state.localSequences);
  const uploaded = new Set(state.uploadedSequences);
  const missingSequences: number[] = [];

  for (let sequence = 1; sequence < state.nextSequence; sequence += 1) {
    if (local.has(sequence) && !uploaded.has(sequence)) {
      missingSequences.push(sequence);
    }
  }

  return {
    missingSequences,
    canResume: missingSequences.length > 0 || state.status === "recovering",
  };
}

export function rotateSession(state: RecordingState): RecordingState {
  return {
    ...state,
    status: "recording",
    nextSequence: state.nextSequence + 1,
  };
}
