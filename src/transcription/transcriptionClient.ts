import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { LocalSegment } from "../recording/localSegmentStore";

export interface TranscriptResult {
  meetingId: string;
  sequence: number;
  text: string;
  model: string;
  provisional?: boolean;
  liveFinal?: boolean;
  overlapUncertain?: boolean;
}

interface TranscribeSegmentRequest {
  meetingId: string;
  sequence: number;
  mimeType: string;
  audioBase64: string;
}

const transcribeSegment = httpsCallable<TranscribeSegmentRequest, TranscriptResult>(
  functions,
  "transcribeSegment",
);

export async function transcribeLocalSegment(segment: LocalSegment): Promise<TranscriptResult> {
  if (segment.blob.size > 25_000_000) {
    throw new Error("Audiosegment is groter dan OpenAI's limiet van 25 MB.");
  }

  const audioBase64 = await blobToBase64(segment.blob);
  const response = await transcribeSegment({
    meetingId: segment.meetingId,
    sequence: segment.sequence,
    mimeType: segment.blob.type || "audio/webm",
    audioBase64,
  });

  return response.data;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Audiosegment kon niet naar base64 worden omgezet."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Audiosegment kon niet worden gelezen."));
    reader.readAsDataURL(blob);
  });
}
