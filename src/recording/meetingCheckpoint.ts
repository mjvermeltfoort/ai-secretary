import type { MeetingNotes } from "../notes/notesClient";
import type { TranscriptResult } from "../transcription/transcriptionClient";
export interface LiveCheckpoint {
  version: 1;
  cursor: number;
  nextSequence: number;
  turns: TranscriptResult[];
}
export interface MeetingCheckpoint {
  id: string;
  updatedAt: number;
  live?: LiveCheckpoint;
  transcripts?: TranscriptResult[];
  notes?: MeetingNotes;
  reviewedAudioCount?: number;
}
export interface CheckpointStore {
  loadMeeting(meetingId: string): Promise<MeetingCheckpoint | undefined>;
  saveMeeting(meetingId: string, patch: Partial<Omit<MeetingCheckpoint, "id" | "updatedAt">>): Promise<void>;
}
