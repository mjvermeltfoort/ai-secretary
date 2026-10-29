// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingNotes } from "../notes/notesClient";

const rig = vi.hoisted(() => ({ options: null as any, start: vi.fn(), startDialogue: vi.fn(), disconnect: vi.fn(), sendText: vi.fn(), updateContext: vi.fn(), notifyDecision: vi.fn(), save: vi.fn(), prepare: vi.fn(), assess: vi.fn(), speakControlled: vi.fn(), interrupt: vi.fn() }));
vi.mock("../notes/notesClient", () => ({ saveActionItemProposal: rig.save }));
vi.mock("./voiceBriefing",()=>({prepareVoiceBriefing:rig.prepare}));
vi.mock("./kneutClient", () => ({ assessClarity: rig.assess }));
vi.mock("./voiceClient", () => ({ createVoiceToken: vi.fn() }));
vi.mock("./voiceSession", () => ({ VoiceSession: class {
  constructor(options: any) { rig.options = options; }
  start = rig.start;
  startDialogue = rig.startDialogue;
  disconnect = rig.disconnect;
  sendText = rig.sendText;
  updateContext = rig.updateContext;
  notifyDecision = rig.notifyDecision;
  speakControlled = rig.speakControlled;
  interrupt = rig.interrupt;
} }));
import { VoicePanel } from "./VoicePanel";

const notes: MeetingNotes = { meetingId: "m1", revision: "rev1", summary: "Vrijdag starten", decisions: [], actionItems: [{ description: "Planning maken", owner: "Mark", deadline: "Donderdag", status: "ready" }], clarificationQuestions: [], model: "test" };
const proposal = { notesRevision: "rev1", itemIndex: 0, description: "Planning maken", owner: "Sarah", deadline: "Donderdag" };
const onNotesUpdated = vi.fn();
function panel(current = notes) { return <VoicePanel meetingId="m1" notes={current} transcripts={[]} onNotesUpdated={onNotesUpdated} />; }
beforeEach(() => { vi.clearAllMocks(); rig.startDialogue.mockResolvedValue(true);rig.prepare.mockImplementation(async(_id,transcripts)=>({summary:"Samenvatting",sourceText:transcripts.filter((t:any)=>!t.provisional||t.liveFinal).map((t:any)=>t.text.trim()).join("\n"),provisional:true}));localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("voice panel", () => {
  it("never starts a paid connection automatically and closes on unmount", async () => {
    const view = render(panel());
    expect(rig.startDialogue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Praat met Kneut" }));
    await waitFor(()=>expect(rig.startDialogue).toHaveBeenCalledOnce());
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


describe("Kneut meeting integration", () => {
  it("shows open questions silently, accepts a wake question and persists deferral", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T13:00:00Z"));
    let speechAt = Date.now()-10000;
    const getSpeechActivity = () => ({lastSpeechAt:speechAt,lastFrameAt:Date.now()});
    const open = {id:"kleding",question:"Wie bestelt de kleding?",evidence:"We bestellen kleding."};
    rig.assess.mockResolvedValue({questions:[open],transition:false});rig.speakControlled.mockResolvedValue(true);rig.startDialogue.mockResolvedValue(true);
    const props = {meetingId:"m1",onNotesUpdated,recording:true,liveAvailable:true,getSpeechActivity};
    const view=render(<VoicePanel {...props} transcripts={[]} />);
    view.rerender(<VoicePanel {...props} transcripts={[{meetingId:"m1",sequence:1,text:"We bestellen kleding. Welke kleur?",model:"test",provisional:true,liveFinal:true}]} />);
    await act(async()=>{await vi.advanceTimersByTimeAsync(500);});
    expect(screen.getByText(open.question)).toBeTruthy();expect(rig.speakControlled).not.toHaveBeenCalled();
    view.rerender(<VoicePanel {...props} transcripts={[{meetingId:"m1",sequence:1,text:"We bestellen kleding. Welke kleur?",model:"test",provisional:true,liveFinal:true},{meetingId:"m1",sequence:2,text:"Kneut, wat is besloten?",model:"test",provisional:true,liveFinal:true}]} />);
    await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
    expect(rig.startDialogue).toHaveBeenCalledWith("wat is besloten?","Kneut, wat is besloten?");
    fireEvent.change(screen.getByRole("combobox",{name:"Vragen stellen"}),{target:{value:"end"}});
    expect(JSON.parse(localStorage.getItem("kneut-m1")!).deferred).toBe(true);
    view.rerender(<VoicePanel {...props} recording={false} stopSignal={1} transcripts={[]} />);
    expect(screen.getByRole("button",{name:"Bespreek open vragen"})).toBeTruthy();
    expect(rig.disconnect).toHaveBeenCalled();
  });
});

it("never treats restored or replayed text as a new wake word",async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T13:00:00Z"));
 const props={meetingId:"m1",onNotesUpdated,recording:true,liveAvailable:true,getSpeechActivity:()=>({lastSpeechAt:Date.now()-10000,lastFrameAt:Date.now()})};
 const view=render(<VoicePanel {...props} transcripts={[]} />);
 view.rerender(<VoicePanel {...props} transcripts={[{meetingId:"m1",sequence:1,text:"Kneut, wat is besloten?",model:"test",provisional:true,liveFinal:true,replayed:true}]} />);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(rig.speakControlled).not.toHaveBeenCalled();expect(rig.assess).not.toHaveBeenCalled();
});

it("scopes the red error style to the alert and exposes concise diagnostic details",()=>{
 render(panel());act(()=>rig.options.onSnapshot({status:"error",micMuted:false,playbackBlocked:false,error:"Verzoek niet verwerkt",diagnostic:{code:"invalid_value",parameter:"item.id",event:"conversation.item.create"}}));
 expect(screen.getByRole("region",{name:"Kneut"}).classList.contains("voice-error")).toBe(false);
 expect(screen.getByRole("alert").classList.contains("voice-error")).toBe(true);
 expect(screen.getByText("Technische foutgegevens")).toBeTruthy();expect(screen.getByText(/Code: invalid_value/)).toBeTruthy();
});

it("switches to dialogue on wake and restores listening when the conversation closes",async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T13:00:00Z"));const change=vi.fn();
 const props={meetingId:"m1",onNotesUpdated,onConsultationChange:change,recording:true,liveAvailable:true,getSpeechActivity:()=>({lastSpeechAt:Date.now()-10000,lastFrameAt:Date.now()})};
 const view=render(<VoicePanel {...props} transcripts={[]} />);
 view.rerender(<VoicePanel {...props} transcripts={[{meetingId:"m1",sequence:1,text:"Kneut, wat is besproken?",model:"test",provisional:true,liveFinal:true}]} />);
 await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
 expect(change).toHaveBeenCalledWith(true);expect(rig.startDialogue).toHaveBeenCalledWith("wat is besproken?","Kneut, wat is besproken?");
 expect(rig.speakControlled).not.toHaveBeenCalled();
 act(()=>rig.options.onSnapshot({status:"listening",controlled:false,micMuted:false,playbackBlocked:false}));
 expect(screen.getByRole("button",{name:"Terug naar meeluisteren"})).toBeTruthy();
 act(()=>rig.options.onSnapshot({status:"idle",controlled:false,micMuted:false,playbackBlocked:false}));
 expect(change).toHaveBeenLastCalledWith(false);
});

it("shows a general summary and reuses it when the conversation starts",async()=>{
 const transcript={meetingId:"m1",sequence:1,text:"Nieuwe kleding besproken. Mark vraagt offertes op.",model:"test"};
 render(<VoicePanel meetingId="m1" transcripts={[transcript]} onNotesUpdated={onNotesUpdated}/>);
 fireEvent.click(screen.getByRole("button",{name:"Maak samenvatting"}));await screen.findByText("Samenvatting",{exact:true});
 expect(rig.prepare).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole("button",{name:"Praat met Kneut"}));
 await waitFor(()=>expect(rig.startDialogue).toHaveBeenCalledOnce());expect(rig.prepare).toHaveBeenCalledOnce();
 expect(JSON.parse(rig.options.getContext()).briefing.summary).toBe("Samenvatting");
});
it("waits for a shared summary and never starts speech after preparation is cancelled",async()=>{
 let resolve!:(value:any)=>void;rig.prepare.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const transcript={meetingId:"m1",sequence:1,text:"Kleding besproken.",model:"test"};
 render(<VoicePanel meetingId="m1" transcripts={[transcript]} onNotesUpdated={onNotesUpdated}/>);
 fireEvent.click(screen.getByRole("button",{name:"Praat met Kneut"}));
 expect(screen.getByText("Leest de vergadering bij…")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Voorbereiden annuleren"}));
 await act(async()=>{resolve({summary:"Kleding besproken.",sourceText:transcript.text,provisional:false});await Promise.resolve();});
 expect(rig.startDialogue).not.toHaveBeenCalled();
});

it("switches tab panels with the keyboard without interrupting the voice session",async()=>{
 render(<VoicePanel meetingId="m1" transcripts={[]} onNotesUpdated={onNotesUpdated} liveContent={<p>Vergadertekst</p>} notesContent={<p>Uitgewerkte afspraken</p>}/>);
 fireEvent.click(screen.getByRole("button",{name:"Praat met Kneut"}));await waitFor(()=>expect(rig.startDialogue).toHaveBeenCalledOnce());
 act(()=>rig.options.onSnapshot({status:"listening",controlled:false,micMuted:false,playbackBlocked:false}));
 const summary=screen.getByRole("tab",{name:"Samenvatting"});summary.focus();fireEvent.keyDown(summary,{key:"ArrowRight"});
 expect(screen.getByRole("tabpanel",{name:"Live tekst"}).textContent).toContain("Vergadertekst");expect(document.activeElement).toBe(screen.getByRole("tab",{name:"Live tekst"}));
 fireEvent.keyDown(document.activeElement!,{key:"End"});expect(screen.getByRole("tabpanel",{name:"Notulen"}).textContent).toContain("Uitgewerkte afspraken");
 expect(rig.disconnect).not.toHaveBeenCalled();expect(rig.startDialogue).toHaveBeenCalledOnce();
});
it("collapses finished dialogue and makes it available without reconnecting",()=>{
 render(panel());act(()=>rig.options.onMessage({id:"a",role:"assistant",text:"Eerder antwoord",final:true}));
 expect(screen.queryByRole("log")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Bekijk laatste gesprek"}));
 expect(screen.getByRole("log").textContent).toContain("Eerder antwoord");expect(rig.startDialogue).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Verberg gesprek"}));expect(screen.queryByRole("log")).toBeNull();
});
