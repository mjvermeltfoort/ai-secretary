import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import OpenAI, { toFile } from "openai";

import { requireOwnerAccess } from "./access";

initializeApp();
export { createVoiceSession, updateMeetingActionItem } from "./voice";
export { createTranscriptionSession, transcribeAudioWindow, finalizeReviewedTranscript } from "./transcription";
const db = getFirestore();
const openAiApiKey = defineSecret("OPENAI_API_KEY");

export const health = onCall({ region: "europe-west1" }, (request) => {
  requireOwnerAccess(request.auth);
  return { service: "ai-vergadersecretaris", status: "ok" };
});

export const transcribeSegment = onCall(
  {
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [openAiApiKey],
  },
  async (request) => {
    const uid = requireOwnerAccess(request.auth);

    const input = request.data as Partial<{
      meetingId: string;
      sequence: number;
      mimeType: string;
      audioBase64: string;
    }>;
    if (!isValidInput(input)) {
      throw new HttpsError("invalid-argument", "Ongeldig transcriptieverzoek.");
    }

    const mimeType = normalizeMimeType(input.mimeType);

    const audioBytes = Math.floor(input.audioBase64.length * 0.75);
    if (audioBytes > 25_000_000) {
      throw new HttpsError("invalid-argument", "Audiosegment is groter dan 25 MB.");
    }

    const apiKey = openAiApiKey.value();
    if (!apiKey) throw new HttpsError("failed-precondition", "OPENAI_API_KEY ontbreekt in Secret Manager.");

    const client = new OpenAI({ apiKey });
    const extension = extensionForMimeType(mimeType);
    const audioFile = await toFile(
      Buffer.from(input.audioBase64, "base64"),
      `segment-${input.sequence}.${extension}`,
      { type: mimeType },
    );
    let transcription: { text: string };
    try {
      transcription = await client.audio.transcriptions.create({
        file: audioFile,
        model: "gpt-transcribe",
        prompt: "Nederlandstalige vergadering. Behoud namen, afkortingen en vaktermen.",
      });
    } catch (cause) {
      if (cause instanceof OpenAI.APIError && cause.status === 400) {
        throw new HttpsError("invalid-argument", "OpenAI kan dit audiosegment niet lezen. Neem het segment opnieuw op.");
      }
      throw cause;
    }

    await db.doc(`users/${uid}/meetings/${input.meetingId}/transcripts/${input.sequence}`).set({
      ownerId: uid,
      sequenceStart: input.sequence,
      sequenceEnd: input.sequence,
      text: transcription.text,
      createdAt: Timestamp.now(),
      source: "openai",
      status: "final",
    });

    return {
      meetingId: input.meetingId,
      sequence: input.sequence,
      text: transcription.text,
      model: "gpt-transcribe",
    } satisfies TranscriptResult;
  },
);

export const generateMeetingNotes = onCall(
  {
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [openAiApiKey],
  },
  async (request) => {
    const uid = requireOwnerAccess(request.auth);

    const input = request.data as Partial<{ meetingId: string }>;
    if (!isValidMeetingInput(input)) {
      throw new HttpsError("invalid-argument", "Ongeldig notulenverzoek.");
    }

    const transcriptSnapshot = await db
      .collection(`users/${uid}/meetings/${input.meetingId}/transcripts`)
      .orderBy("sequenceStart")
      .get();
    const reviewed = (await db.doc(`users/${uid}/meetings/${input.meetingId}/transcriptRuns/latest`).get()).data();
    const transcript = typeof reviewed?.text === "string" ? reviewed.text : transcriptSnapshot.docs
      .map((document) => document.data())
      .filter((document) => document.status === "final" && typeof document.text === "string")
      .map((document) => `Segment ${document.sequenceStart}: ${document.text.trim()}`)
      .filter((segment) => segment.length > 10)
      .join("\n");

    if (!transcript) {
      throw new HttpsError("failed-precondition", "Geen afgeronde transcriptie beschikbaar.");
    }
    if (transcript.length > 120_000) {
      throw new HttpsError("invalid-argument", "Transcriptie is te lang voor deze notulensessie.");
    }

    const apiKey = openAiApiKey.value();
    if (!apiKey) throw new HttpsError("failed-precondition", "OPENAI_API_KEY ontbreekt in Secret Manager.");

    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "Je bent een Nederlandse notulist.",
                "Gebruik alleen informatie uit de transcriptie.",
                "Verzin geen namen, deadlines, besluiten of feiten. Vragen aan de AI en AI-suggesties zijn geen toezeggingen of besluiten. Leid geen feiten af uit [onverstaanbaar] of [door elkaar gesproken].",
                "Gebruik lege strings voor onbekende eigenaar of deadline.",
                "Maak actiepunten concreet en neem alleen echte toezeggingen op.",
                "Antwoord uitsluitend volgens het opgegeven JSON-schema.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: transcript }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_notes",
          strict: true,
          schema: meetingNotesSchema,
        },
      },
    });

    if (!response.output_text) {
      throw new HttpsError("internal", "OpenAI gaf geen notulen terug.");
    }

    let generated: GeneratedMeetingNotes;
    try {
      generated = JSON.parse(response.output_text) as GeneratedMeetingNotes;
    } catch {
      throw new HttpsError("internal", "OpenAI gaf ongeldige notulen terug.");
    }

    const notes = normalizeMeetingNotes(generated);
    const revision = randomUUID();
    await db.doc(`users/${uid}/meetings/${input.meetingId}/notes/latest`).set({
      ownerId: uid,
      revision,
      summary: notes.summary,
      decisions: notes.decisions,
      actionItems: notes.actionItems,
      clarificationQuestions: notes.clarificationQuestions,
      createdAt: Timestamp.now(),
      model: "gpt-4o-mini",
    });

    return {
      meetingId: input.meetingId,
      revision,
      ...notes,
      model: "gpt-4o-mini",
    } satisfies MeetingNotesResult;
  },
);

const meetingNotesSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          owner: { type: "string" },
          deadline: { type: "string" },
        },
        required: ["description", "owner", "deadline"],
      },
    },
    clarificationQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "decisions", "actionItems", "clarificationQuestions"],
} as const;

function isValidMeetingInput(input: Partial<{ meetingId: string }>): input is { meetingId: string } {
  return typeof input.meetingId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(input.meetingId);
}

function normalizeMeetingNotes(generated: GeneratedMeetingNotes): Omit<MeetingNotesResult, "meetingId" | "model" | "revision"> {
  const clarificationQuestions = generated.clarificationQuestions.filter((question) => question.trim().length > 0);
  const actionItems = generated.actionItems
    .filter((item) => item.description.trim().length > 0)
    .map((item) => {
      const owner = item.owner.trim() || null;
      const deadline = item.deadline.trim() || null;
      if (!owner || !deadline) {
        clarificationQuestions.push(
          `Wie is eigenaar van actiepunt "${item.description.trim()}" en wat is de deadline?`,
        );
      }
      return {
        description: item.description.trim(),
        owner,
        deadline,
        status: owner && deadline ? "ready" : "needs_clarification",
      } as const;
    });

  return {
    summary: generated.summary.trim(),
    decisions: generated.decisions.map((decision) => decision.trim()).filter(Boolean),
    actionItems,
    clarificationQuestions: [...new Set(clarificationQuestions.map((question) => question.trim()).filter(Boolean))],
  };
}

function isValidInput(input: Partial<TranscribeSegmentRequest>): input is TranscribeSegmentRequest {
  return typeof input.meetingId === "string"
    && /^[a-zA-Z0-9_-]{1,100}$/.test(input.meetingId)
    && typeof input.sequence === "number"
    && Number.isInteger(input.sequence)
    && input.sequence > 0
    && typeof input.mimeType === "string"
    && /^audio\/(webm|mp4|wav|mpeg)(;.*)?$/i.test(input.mimeType)
    && typeof input.audioBase64 === "string"
    && /^[A-Za-z0-9+/=]+$/.test(input.audioBase64);
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

function extensionForMimeType(mimeType: string): string {
  return mimeType === "audio/mp4" ? "mp4" : mimeType === "audio/wav" ? "wav" : mimeType === "audio/mpeg" ? "mp3" : "webm";
}

interface TranscribeSegmentRequest {
  meetingId: string;
  sequence: number;
  mimeType: string;
  audioBase64: string;
}

interface TranscriptResult {
  meetingId: string;
  sequence: number;
  text: string;
  model: string;
}

interface GeneratedMeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: Array<{
    description: string;
    owner: string;
    deadline: string;
  }>;
  clarificationQuestions: string[];
}

interface MeetingNotesResult {
  meetingId: string;
  revision: string;
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
