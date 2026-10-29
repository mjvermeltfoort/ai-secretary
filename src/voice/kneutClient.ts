import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { Assessment } from "./kneutController";
const assess = httpsCallable<{meetingId: string; text: string}, Assessment>(functions, "assessMeetingClarity");
export async function assessClarity(meetingId: string, text: string) { return (await assess({meetingId, text})).data; }
