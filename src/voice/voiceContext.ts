import type { MeetingNotes, ActionItemProposal } from "../notes/notesClient";
import type { TranscriptResult } from "../transcription/transcriptionClient";

export function meetingVoiceContext(meetingId: string, transcripts: TranscriptResult[], notes?: MeetingNotes): string {
  const transcript = transcripts.filter((item) => item.meetingId === meetingId)
    .sort((a, b) => a.sequence - b.sequence).map((item) => item.text).join("\n");
  const currentNotes = notes?.meetingId === meetingId ? notes : undefined;
  // Keep full action items so correcting an owner cannot overwrite a truncated description.
  const actionItems: Array<MeetingNotes["actionItems"][number] & { itemIndex: number }> = [];
  let actionCharacters = 0;
  for (const [itemIndex, item] of (currentNotes?.actionItems ?? []).entries()) {
    const entry = { itemIndex, ...item };
    actionCharacters += JSON.stringify(entry).length;
    if (actionCharacters > 12_000 || actionItems.length >= 100) break;
    actionItems.push(entry);
  }
  return JSON.stringify({
    meetingId,
    transcriptIncomplete: transcript.length > 12_000,
    recentTranscript: transcript.slice(-12_000),
    notes: currentNotes ? {
      revision: currentNotes.revision,
      notesExcerpt: true,
      summary: currentNotes.summary.slice(0, 2000),
      decisions: currentNotes.decisions.slice(0, 15).map((text) => text.slice(0, 200)),
      actionItemsIncomplete: actionItems.length < currentNotes.actionItems.length,
      actionItems,
    } : null,
  });
}

export interface VoiceActionItemProposal extends ActionItemProposal { notesRevision: string; }

export function parseActionItemProposal(value: unknown): VoiceActionItemProposal | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (typeof item.notesRevision !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.notesRevision)
    || !Number.isInteger(item.itemIndex) || (item.itemIndex as number) < 0 || (item.itemIndex as number) > 99
    || typeof item.description !== "string" || !item.description.trim() || item.description.length > 2000
    || typeof item.owner !== "string" || item.owner.length > 320
    || typeof item.deadline !== "string" || item.deadline.length > 100) return;
  return { notesRevision: item.notesRevision, itemIndex: item.itemIndex as number, description: item.description.trim(), owner: item.owner.trim(), deadline: item.deadline.trim() };
}
