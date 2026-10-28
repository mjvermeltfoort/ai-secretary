import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";

export interface MeetingNotes {
  meetingId: string;
  summary: string;
  decisions: string[];
  actionItems: Array<{
    description: string;
    owner: string | null;
    deadline: string | null;
    status: "ready" | "needs_clarification";
  }>;
  clarificationQuestions: string[];
  model: string;
}

const generateMeetingNotes = httpsCallable<{ meetingId: string }, MeetingNotes>(
  functions,
  "generateMeetingNotes",
);

export async function createMeetingNotes(meetingId: string): Promise<MeetingNotes> {
  const response = await generateMeetingNotes({ meetingId });
  return response.data;
}
