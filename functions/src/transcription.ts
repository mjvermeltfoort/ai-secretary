import { defineSecret } from "firebase-functions/params";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import OpenAI, { toFile } from "openai";
import { requireOwnerAccess } from "./access";
import { validMeetingId } from "./voice";
const key = defineSecret("OPENAI_API_KEY");
const options = { region: "europe-west1", timeoutSeconds: 120, memory: "512MiB" as const, maxInstances: 3 };

export const createTranscriptionSession = onCall({ ...options, secrets: [key] }, async request => {
  requireOwnerAccess(request.auth);
  if (!request.data || !validMeetingId(request.data.meetingId)) throw new HttpsError("invalid-argument", "Ongeldige vergadering.");
  const secret = key.value();
  if (!secret) throw new HttpsError("failed-precondition", "OpenAI is niet ingesteld.");
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST", signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: {
        type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-live-transcribe", languages: ["nl"], delay: "medium", prompt: "Nederlandstalige vergadering. Namen, getallen, vaktermen en besluiten nauwkeurig overnemen. Geen sprekerlabels." },
          turn_detection: null,
        } },
      } }),
    });
    if (!response.ok) throw new HttpsError(response.status === 429 ? "resource-exhausted" : "unavailable", "Live transcriptie is niet beschikbaar. Je lokale opname blijft bewaard voor verwerking na afloop.");
    const token = await response.json() as { value?: string; expires_at?: number };
    if (!token.value?.startsWith("ek_") || !token.expires_at) throw new HttpsError("unavailable", "Geen geldige tijdelijke spraaktoegang ontvangen.");
    return { value: token.value, expiresAt: token.expires_at };
  } catch (cause) { if (cause instanceof HttpsError) throw cause; throw new HttpsError("unavailable", "Live transcriptie niet bereikbaar. De lokale opname kan later worden verwerkt."); }
});

export interface WindowInput { meetingId: string; runId: string; sequence: number; totalWindows: number; startMs: number; endMs: number; audioBase64: string; }
export function validateWindow(value: unknown): WindowInput {
  const x = value as WindowInput | null;
  if (!x || !validMeetingId(x.meetingId) || !validMeetingId(x.runId)
    || !Number.isInteger(x.sequence) || !Number.isInteger(x.totalWindows) || x.sequence < 1 || x.sequence > x.totalWindows || x.totalWindows > 1000
    || !Number.isInteger(x.startMs) || !Number.isInteger(x.endMs) || x.startMs < 0 || x.endMs <= x.startMs || x.endMs - x.startMs > 65000
    || typeof x.audioBase64 !== "string" || x.audioBase64.length > 4_300_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(x.audioBase64)) {
    throw new HttpsError("invalid-argument", "Ongeldig audiovenster.");
  }
  return x;
}
export function verifyWav(bytes: Buffer, durationMs: number) {
  if (bytes.length < 44 || bytes.toString("ascii",0,4) !== "RIFF" || bytes.toString("ascii",8,12) !== "WAVE"
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 24000 || bytes.readUInt16LE(34) !== 16
    || bytes.toString("ascii",36,40) !== "data" || bytes.readUInt32LE(40) !== bytes.length - 44
    || Math.abs((bytes.length - 44) / 48 - durationMs) > 1) throw new HttpsError("invalid-argument", "Audioformaat of duur klopt niet.");
}
export function removeOverlap(previous: string, current: string, hasOverlap: boolean) {
  if (!hasOverlap) return { text: current.trim(), overlapUncertain: false };
  const old = previous.trim().split(/\s+/); const next = current.trim().split(/\s+/);
  const normalize = (s: string) => s.toLocaleLowerCase("nl").replace(/[^\p{L}\p{N}]/gu, "");
  for (let n = Math.min(40, old.length, next.length); n >= 3; n--) {
    if (old.slice(-n).map(normalize).join(" ") === next.slice(0,n).map(normalize).join(" ")) return { text: next.slice(n).join(" "), overlapUncertain: false };
  }
  // Preserve uncertain text instead of silently dropping or inventing words.
  return { text: current.trim(), overlapUncertain: !!previous.trim() && !!current.trim() };
}
export const transcribeAudioWindow = onCall({ ...options, secrets: [key] }, async request => {
  const uid = requireOwnerAccess(request.auth); const input = validateWindow(request.data);
  const bytes = Buffer.from(input.audioBase64, "base64"); verifyWav(bytes, input.endMs - input.startMs);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const db = getFirestore(); const base = `users/${uid}/meetings/${input.meetingId}/transcriptRuns/${input.runId}`;
  const target = db.doc(`${base}/windows/${input.sequence}`);
  const cached = await target.get();
  if (cached.exists) {
    const value = cached.data()!;
    if (value.hash !== hash || value.startMs !== input.startMs || value.endMs !== input.endMs || value.totalWindows !== input.totalWindows) throw new HttpsError("already-exists", "Deze herstelronde bevat andere audio. Start een nieuwe ronde.");
    return { meetingId: input.meetingId, sequence: input.sequence, text: value.text, overlapUncertain: value.overlapUncertain, model: "gpt-transcribe" };
  }
  const previous = input.sequence > 1 ? (await db.doc(`${base}/windows/${input.sequence - 1}`).get()).data() : undefined;
  if (input.sequence > 1 && !previous) throw new HttpsError("failed-precondition", "Verwerk eerst het vorige audiovenster.");
  if(previous && input.endMs <= previous.endMs)throw new HttpsError("invalid-argument", "Het volgende venster moet nieuwe audio bevatten.");
  if ((input.sequence === 1 && input.startMs !== 0) || (previous && input.startMs !== Math.max(0, previous.endMs - 4000))) throw new HttpsError("invalid-argument", "Audiovensters sluiten niet op elkaar aan.");
  const secret = key.value(); if (!secret) throw new HttpsError("failed-precondition", "OpenAI is niet ingesteld.");
  const client = new OpenAI({ apiKey: secret });
  const result = await client.audio.transcriptions.create({ file: await toFile(bytes, "vergadering.wav", { type: "audio/wav" }), model: "gpt-transcribe",
    prompt: `Nederlandstalige vergadering, geen sprekerlabels. Neem alleen hoorbare woorden over; markeer onverstaanbare passages als [onverstaanbaar]. Context uit het vorige venster (niet herhalen als het niet in de audio voorkomt): ${String(previous?.rawText ?? "").slice(-1000)}`,
  });
  const joined = removeOverlap(String(previous?.rawText ?? ""), result.text, input.sequence > 1);
  await target.set({ ...joined, rawText: result.text, hash, startMs: input.startMs, endMs: input.endMs, sequence: input.sequence, totalWindows: input.totalWindows, createdAt: Timestamp.now() });
  return { meetingId: input.meetingId, sequence: input.sequence, ...joined, model: "gpt-transcribe" };
});
export function validateReviewedWindows(windows: Array<Record<string, any>>, totalWindows: number) {
  if(windows.length !== totalWindows || !windows.length || windows.some((w,i)=>w.sequence!==i+1 || w.totalWindows!==totalWindows || (i===0?w.startMs!==0:w.startMs!==Math.max(0,windows[i-1].endMs-4000) || w.endMs<=windows[i-1].endMs)))throw new HttpsError("failed-precondition", "De opname is nog niet volledig verwerkt.");
  return windows.map(w=>w.text).join("\n");
}
export const finalizeReviewedTranscript = onCall(options, async request => {
  const uid = requireOwnerAccess(request.auth); const input = request.data;
  if (!input || !validMeetingId(input.meetingId) || !validMeetingId(input.runId) || !Number.isInteger(input.totalWindows) || input.totalWindows < 1 || input.totalWindows > 1000) throw new HttpsError("invalid-argument", "Ongeldige herstelronde.");
  const db = getFirestore(); const parent = `users/${uid}/meetings/${input.meetingId}`;
  const windows = (await db.collection(`${parent}/transcriptRuns/${input.runId}/windows`).orderBy("sequence").get()).docs.map(d => d.data());
  const text = validateReviewedWindows(windows, input.totalWindows);
  if (text.length > 120_000) throw new HttpsError("invalid-argument", "Deze vergadering is te lang voor één notulenronde. De vensters en audio blijven bewaard.");
  await db.doc(`${parent}/transcriptRuns/latest`).set({ runId: input.runId, text, warnings: windows.filter(w=>w.overlapUncertain).map(w=>w.sequence), createdAt: Timestamp.now() });
  return { runId: input.runId, totalWindows: windows.length };
});
