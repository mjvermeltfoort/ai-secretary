import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { VoiceToken } from "./voiceSession";

const createSession = httpsCallable<{ meetingId: string }, VoiceToken>(functions, "createVoiceSession");

export async function createVoiceToken(meetingId: string): Promise<VoiceToken> {
  return (await createSession({ meetingId })).data;
}
