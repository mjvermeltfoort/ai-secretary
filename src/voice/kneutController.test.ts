import { describe, expect, it, vi } from "vitest";
import { addressKneut, isTopicTransition, KneutController, type KneutInput, type Assessment, type KneutState } from "./kneutController";
const q = { id: "kleding", question: "Wie bestelt de kleding?", evidence: "We bestellen kleding." };
function rig() {
  let now = 200000;
  const input: KneutInput = { text: "", turns: [], incomplete: false, recording: true, live: true, lastSpeechAt: 190000, lastFrameAt: now, voiceBusy: false, manualDialogue: false };
  let state: KneutState | undefined;
  const assess = vi.fn(async (_text: string): Promise<Assessment> => ({ questions: [q], transition: true }));
  const speak = vi.fn(async (_text: string, allowed: () => boolean) => allowed());
  const interrupt = vi.fn();
  const controller = new KneutController({ getInput: () => input, assess, speak, interrupt, now: () => now, onChange: s => { state = s; } });
  return { input, assess, speak, interrupt, controller, state: () => state, advance: (ms: number) => { now += ms; input.lastFrameAt = now; }, speech: () => { input.lastSpeechAt = now; }, tick: async () => { controller.tick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } };
}

describe("addressing Kneut", () => {
  it.each(["Kneut, wat is besloten?", "Hey Kneut, wat is besloten?", "kneut wat is besloten?"])("recognizes direct address: %s", value => expect(addressKneut(value)).toBe("wat is besloten?"));
  it.each(["Dat kan Kneut straks opschrijven", "De Heikneuters bestellen kleding", "We vragen het straks aan Kneut", "kneuterig"])("ignores a mention: %s", value => expect(addressKneut(value)).toBeUndefined());
  it("waits for the full question and a quiet microphone", async () => {
    const r = rig(); r.input.turns = [{ id: 1, text: "Kneut?" }]; r.input.text = "Kneut?"; r.speech(); await r.tick();
    expect(r.state()?.listening).toBe(true); expect(r.speak).not.toHaveBeenCalled();
    r.advance(1000); r.input.turns.push({ id: 2, text: "Welke afspraken hebben we gemaakt?" }); r.input.text += " Welke afspraken hebben we gemaakt?"; r.speech(); await r.tick();
    r.advance(2000); r.input.incomplete = true; await r.tick(); expect(r.speak).not.toHaveBeenCalled();
    r.input.incomplete = false; await r.tick(); expect(r.speak).toHaveBeenCalledOnce(); expect(r.speak.mock.calls[0][0]).toContain("Welke afspraken");
  });
  it("accepts the next question after answering a bare wake word, without opening general dialogue", async () => {
    const r = rig(); r.input.turns = [{id:1,text:"Kneut?"}]; r.input.text="Kneut?";
    await r.tick();expect(r.speak).toHaveBeenCalledOnce();
    r.advance(2500);r.input.turns.push({id:2,text:"Welke afspraken hebben we gemaakt?"});r.input.text+=" Welke afspraken hebben we gemaakt?";
    await r.tick();expect(r.speak).toHaveBeenCalledTimes(2);
    r.advance(2500);r.input.turns.push({id:3,text:"We praten nu verder."});await r.tick();expect(r.speak).toHaveBeenCalledTimes(2);
  });
  it("defers questions by voice and still answers direct requests", async () => {
    const r = rig(); r.input.turns = [{ id: 1, text: "Kneut, bewaar je vragen tot het einde" }]; r.input.text = r.input.turns[0].text;
    await r.tick(); expect(r.state()?.deferred).toBe(true); expect(r.speak).toHaveBeenCalledOnce();
  });
});

describe("polite clarification", () => {
  it("does not interrupt an ongoing discussion, even during long thinking pauses", async () => {
    const r = rig(); r.input.text = "We bestellen kleding. Welke kleur willen we?"; await r.tick(); await r.tick();
    r.advance(20000); await r.tick(); expect(r.state()?.questions).toEqual([q]); expect(r.speak).not.toHaveBeenCalled();
  });
  it("requires semantic agreement, an explicit transition, silence and fresh audio", async () => {
    const r = rig(); r.input.text = "We bestellen kleding. Akkoord, volgende punt."; r.speech(); await r.tick();
    r.advance(2000); await r.tick(); expect(r.speak).not.toHaveBeenCalled();
    r.advance(1100); r.input.lastFrameAt = 0; await r.tick(); expect(r.speak).not.toHaveBeenCalled();
    r.advance(1); await r.tick(); expect(r.speak).toHaveBeenCalledOnce();
    r.advance(150000); await r.tick(); expect(r.speak).toHaveBeenCalledOnce();
  });
  it("removes a question answered later before the next transition", async () => {
    const r = rig(); r.input.text = "We bestellen kleding."; await r.tick();
    r.assess.mockResolvedValue({questions: [], transition: true});
    r.advance(13000); r.input.text += " Mark bestelt de kleding. Akkoord, volgende punt."; await r.tick(); await r.tick();
    expect(r.state()?.questions).toEqual([]); expect(r.speak).not.toHaveBeenCalled();
  });
  it("discards late assessments when discussion continues", async () => {
    const r = rig(); let resolve!: (a: Assessment) => void;
    r.assess.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    r.input.text = "Akkoord, volgende punt."; await r.tick(); r.input.text += " Wacht, we zijn nog niet klaar.";
    resolve({questions:[q], transition:true}); await r.tick(); await r.tick(); expect(r.speak).not.toHaveBeenCalled();
  });
  it("rechecks the latest speech before playback and postpones if anyone starts", async () => {
    const r = rig(); let allowed!: () => boolean;
    r.speak.mockImplementationOnce(async (_text, check) => { allowed = check; return false; });
    r.input.text = "We bestellen kleding. Akkoord, volgende punt."; await r.tick(); await r.tick();
    r.speech(); expect(allowed()).toBe(false);
  });
  it("enforces the cooldown for a different question and supports deferred mode", async () => {
    const r = rig(); r.input.text = "Akkoord, volgende punt."; await r.tick(); await r.tick(); expect(r.speak).toHaveBeenCalledOnce();
    r.advance(13000); r.input.text += " We regelen catering. Akkoord, volgende punt.";
    r.assess.mockResolvedValue({questions:[{...q,id:"catering"}], transition:true}); await r.tick(); await r.tick(); expect(r.speak).toHaveBeenCalledOnce();
    r.controller.defer(true); r.advance(130000); await r.tick(); expect(r.speak).toHaveBeenCalledOnce();
    r.controller.defer(false); await r.tick(); expect(r.speak).toHaveBeenCalledTimes(2);
  });
  it("interrupts Kneut when participants speak and stays silent offline or paused", async () => {
    const r = rig(); r.input.voiceBusy = true; r.speech(); await r.tick(); expect(r.interrupt).toHaveBeenCalled();
    r.input.recording = false; r.input.turns = [{id:1,text:"Kneut, hallo"}]; await r.tick();
    r.input.recording = true; r.input.live = false; r.advance(10000); await r.tick(); expect(r.speak).not.toHaveBeenCalled();
    r.input.live = true; await r.tick(); expect(r.speak).not.toHaveBeenCalled();
  });
  it("invalidates pending speech and in-flight work on disposal", async () => {
    const r = rig(); let allowed!: () => boolean;
    r.speak.mockImplementationOnce(async (_text, check) => { allowed = check; return false; });
    r.input.turns = [{id:1,text:"Kneut, hallo"}]; r.input.text = "Kneut, hallo"; await r.tick(); r.controller.dispose(); expect(allowed()).toBe(false);
  });
  it("does not mistake a transition followed by disagreement for an opportunity", () => {
    expect(isTopicTransition("Akkoord, volgende punt.")).toBe(true);
    expect(isTopicTransition("Akkoord, volgende punt. Maar wie betaalt dat?")).toBe(false);
    expect(isTopicTransition("Dan gaan we verder met de catering.")).toBe(true);
  });
});
