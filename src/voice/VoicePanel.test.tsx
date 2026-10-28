// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingNotes } from "../notes/notesClient";

const rig = vi.hoisted(() => ({ options: null as any, start: vi.fn(), disconnect: vi.fn(), sendText: vi.fn(), updateContext: vi.fn(), notifyDecision: vi.fn(), save: vi.fn() }));
vi.mock("../notes/notesClient", () => ({ saveActionItemProposal: rig.save }));
vi.mock("./voiceClient", () => ({ createVoiceToken: vi.fn() }));
vi.mock("./voiceSession", () => ({ VoiceSession: class {
  constructor(options: any) { rig.options = options; }
  start = rig.start;
  disconnect = rig.disconnect;
  sendText = rig.sendText;
  updateContext = rig.updateContext;
  notifyDecision = rig.notifyDecision;
} }));
import { VoicePanel } from "./VoicePanel";

const notes: MeetingNotes = { meetingId: "m1", revision: "rev1", summary: "Vrijdag starten", decisions: [], actionItems: [{ description: "Planning maken", owner: "Mark", deadline: "Donderdag", status: "ready" }], clarificationQuestions: [], model: "test" };
const proposal = { notesRevision: "rev1", itemIndex: 0, description: "Planning maken", owner: "Sarah", deadline: "Donderdag" };
const onNotesUpdated = vi.fn();
function panel(current = notes) { return <VoicePanel meetingId="m1" notes={current} transcripts={[]} onNotesUpdated={onNotesUpdated} />; }
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("voice panel", () => {
  it("never starts a paid connection automatically and closes on unmount", () => {
    const view = render(panel());
    expect(rig.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Praat met de notulist" }));
    expect(rig.start).toHaveBeenCalledOnce();
    view.unmount();
    expect(rig.disconnect).toHaveBeenCalledOnce();
  });
  it("requires explicit confirmation before saving an AI proposal", async () => {
    render(panel());
    act(() => { rig.options.onProposal(proposal); });
    expect(screen.getByText("Sarah")).toBeTruthy();
    expect(rig.save).not.toHaveBeenCalled();
    rig.save.mockResolvedValueOnce({ ...notes, revision: "rev2", actionItems: [{ ...notes.actionItems[0], owner: "Sarah" }] });
    fireEvent.click(screen.getByRole("button", { name: "Wijziging opslaan" }));
    await waitFor(() => expect(onNotesUpdated).toHaveBeenCalledOnce());
    expect(rig.save).toHaveBeenCalledWith("m1", "rev1", { itemIndex: 0, description: "Planning maken", owner: "Sarah", deadline: "Donderdag" });
    expect(screen.getByText("Actiepunt opgeslagen in de notulen.")).toBeTruthy();
  });
  it("rejects a proposal without modifying notes", () => {
    render(panel());
    act(() => { rig.options.onProposal(proposal); });
    fireEvent.click(screen.getByRole("button", { name: "Afwijzen" }));
    expect(rig.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Wijziging opslaan" })).toBeNull();
  });
  it("disables confirmation when notes change after the proposal", () => {
    const view = render(panel());
    act(() => { rig.options.onProposal(proposal); });
    view.rerender(panel({ ...notes, revision: "rev2" }));
    expect((screen.getByRole("button", { name: "Wijziging opslaan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(rig.save).not.toHaveBeenCalled();
  });
  it("does not apply a tool proposal based on stale context", () => {
    render(panel());
    let result: string;
    act(() => { result = rig.options.onProposal({ ...proposal, notesRevision: "old" }); });
    expect(result!).toContain("notulen zijn gewijzigd");
    expect(screen.queryByRole("button", { name: "Wijziging opslaan" })).toBeNull();
  });
});
