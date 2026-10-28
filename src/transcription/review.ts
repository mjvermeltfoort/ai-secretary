import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { LocalSegment } from "../recording/localSegmentStore";
import { pcm16, readWav, SAMPLE_RATE, wav } from "../recording/pcm";
import type { TranscriptResult } from "./transcriptionClient";
export function windowRanges(samples: number): Array<{ start: number; end: number }> {
  const result = []; let start = 0;
  while (start < samples) {
    const end = Math.min(samples, start + 60 * SAMPLE_RATE); result.push({ start, end });
    if (end === samples) break;
    start = end - 4 * SAMPLE_RATE;
  }
  return result;
}
export async function* audioWindows(segments: LocalSegment[]) {
  const sorted = [...segments].sort((a,b)=>a.sequence-b.sequence);
  if (!sorted.length || sorted.some((s,i)=>s.sequence!==i+1)) throw new Error("Lokale audio ontbreekt. De aanwezige bestanden blijven behouden.");
  let decoder: AudioContext | undefined;
  const decode = async (segment: LocalSegment): Promise<Int16Array> => {
    if(segment.blob.type === "audio/wav")return readWav(segment.blob);
    // Older self-contained MediaRecorder files remain recoverable in Chrome.
    decoder ??= new AudioContext({sampleRate:SAMPLE_RATE});
    const buffer=await decoder.decodeAudioData(await segment.blob.arrayBuffer());
    if(buffer.sampleRate!==SAMPLE_RATE)throw new Error("Deze oudere opname kan hier niet worden omgezet. De audio blijft bewaard.");
    const mono=new Float32Array(buffer.length);
    for(let c=0;c<buffer.numberOfChannels;c++) { const channel=buffer.getChannelData(c); for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/buffer.numberOfChannels; }
    return pcm16(mono);
  };
  try {
    let total = 0;
    const entries: Array<{segment:LocalSegment;start:number;end:number}>=[];
    for(const segment of sorted) {
      const samples = segment.blob.type === "audio/wav" ? (segment.blob.size-44)/2 : (await decode(segment)).length;
      if(!Number.isInteger(samples)||samples<=0)throw new Error("Ongeldig lokaal audiobestand. De audio blijft bewaard.");
      entries.push({segment,start:total,end:total+samples});total+=samples;
    }
    const ranges = windowRanges(total); const cache = new Map<number, Int16Array>();
    for (const [i, range] of ranges.entries()) {
      const output = new Int16Array(range.end - range.start);
      for (const entry of entries) {
        if (entry.end <= range.start) { cache.delete(entry.segment.sequence); continue; }
        if (entry.start >= range.end) break;
        let samples = cache.get(entry.segment.sequence);
        if (!samples) { samples = await decode(entry.segment); cache.set(entry.segment.sequence, samples); }
        const from = Math.max(entry.start, range.start), to = Math.min(entry.end, range.end);
        output.set(samples.subarray(from - entry.start, to - entry.start), from - range.start);
      }
      yield { blob: wav(output), sequence: i+1, totalWindows: ranges.length, startMs: Math.round(range.start * 1000/SAMPLE_RATE), endMs: Math.round(range.end * 1000/SAMPLE_RATE) };
    }
  } finally { await decoder?.close(); }
}

const transcribeWindow = httpsCallable<Record<string, unknown>, TranscriptResult & { overlapUncertain?: boolean }>(functions, "transcribeAudioWindow", { timeout: 130000 });
const finalize = httpsCallable<Record<string, unknown>, { runId: string }>(functions, "finalizeReviewedTranscript");
export async function reviewRecording(meetingId: string, segments: LocalSegment[], progress: (done: number, total: number) => void, allowed: () => boolean = () => true): Promise<TranscriptResult[]> {
  const manifest = segments.map(s=>[s.id,s.sequence,s.createdAt,s.blob.size,s.durationMs]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(manifest)));
  const runId = `review-${Array.from(new Uint8Array(hash), x=>x.toString(16).padStart(2,"0")).join("").slice(0,32)}`;
  const result: TranscriptResult[] = []; let totalWindows = 0;
  for await (const window of audioWindows(segments)) {
    if(!allowed())throw new Error("Verwerking afgebroken: de sessie of toegang is gewijzigd.");
    totalWindows = window.totalWindows; progress(window.sequence-1, totalWindows);
    const bytes = new Uint8Array(await window.blob.arrayBuffer()); let binary = "";
    for (let i=0;i<bytes.length;i+=16000) binary += String.fromCharCode(...bytes.subarray(i,i+16000));
    const response = await transcribeWindow({ meetingId, runId, sequence: window.sequence, totalWindows, startMs: window.startMs, endMs: window.endMs, audioBase64: btoa(binary) });
    result.push(response.data); progress(window.sequence,totalWindows);
  }
  if (!totalWindows) throw new Error("Er is geen lokale audio beschikbaar.");
  if(!allowed())throw new Error("Verwerking afgebroken.");
  await finalize({ meetingId, runId, totalWindows });
  return result;
}
