import { describe, expect, it } from "vitest";
import { meetingVoiceContext, parseActionItemProposal } from "./voiceContext";
import type { MeetingNotes } from "../notes/notesClient";

const notes: MeetingNotes = { meetingId: "m1", revision: "rev1", summary: "Samenvatting", decisions: ["Vrijdag starten"], actionItems: [{ description: "Planning maken", owner: "Mark", deadline: "Donderdag", status: "ready" }], clarificationQuestions: [], model: "test" };
describe("meeting context", () => {
  it("filters other meetings and preserves full action items and revision", () => {
    const value = JSON.parse(meetingVoiceContext("m1", [{ meetingId: "m1", sequence: 2, text: "Tweede", model: "test" }, { meetingId: "other", sequence: 1, text: "Privé", model: "test" }], notes));
    expect(value.recentTranscript).toBe("Tweede");
    expect(value.notes.actionItems[0]).toEqual({ itemIndex: 0, ...notes.actionItems[0] });
    expect(value.notes.revision).toBe("rev1");
    expect(JSON.parse(meetingVoiceContext("other", [], notes)).notes).toBeNull();
  });
  it("bounds context without truncating action descriptions", () => {
    const long = { ...notes, actionItems: Array.from({ length: 100 }, () => ({ ...notes.actionItems[0], description: "x".repeat(2000) })) };
    const text = meetingVoiceContext("m1", [{ meetingId: "m1", sequence: 1, text: "x".repeat(30_000), model: "test" }], long);
    const value = JSON.parse(text);
    expect(text.length).toBeLessThan(30_000);
    expect(value.transcriptIncomplete).toBe(true);
    expect(value.notes.actionItemsIncomplete).toBe(true);
    expect(value.notes.actionItems[0].description).toHaveLength(2000);
  });
  it("rejects malformed, oversized and unversioned proposals", () => {
    const valid = { notesRevision: "rev1", itemIndex: 0, description: "Planning", owner: "Mark", deadline: "Donderdag" };
    expect(parseActionItemProposal(valid)).toEqual(valid);
    for (const value of [null, {}, { ...valid, itemIndex: -1 }, { ...valid, notesRevision: "" }, { ...valid, description: "x".repeat(2001) }, { ...valid, deadline: 123 }]) expect(parseActionItemProposal(value)).toBeUndefined();
  });
});
