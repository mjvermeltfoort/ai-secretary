import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSession, type VoiceSnapshot, type VoiceMessage } from "./voiceSession";

class Channel {
  readyState = "connecting";
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: Record<string, any>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  open() { this.readyState = "open"; this.onopen?.(); }
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
class Peer {
  static instances: Peer[] = [];
  channel = new Channel();
  connectionState = "new";
  onconnectionstatechange?: () => void;
  ontrack?: unknown;
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "test-offer" }));
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => { this.channel.open(); });
  createDataChannel() { return this.channel; }
  close() { this.connectionState = "closed"; this.onconnectionstatechange?.(); }
  constructor() { Peer.instances.push(this); }
}

function setup() {
  const track = { stop: vi.fn(), enabled: true };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("RTCPeerConnection", Peer);
  const fetcher = vi.fn(async () => new Response("test-answer", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const audio = { srcObject: null, muted: false, play: vi.fn(async () => undefined), pause: vi.fn() };
  const snapshots: VoiceSnapshot[] = [];
  const messages: VoiceMessage[] = [];
  const createToken = vi.fn(async () => ({ value: "ek_test", expiresAt: Date.now() / 1000 + 60, model: "test", instructions: "server instructions" }));
  const proposal = vi.fn(() => "wacht op bevestiging");
  const context = vi.fn(() => '{"meetingId":"meeting-1"}');
  const voice = new VoiceSession({ audio: audio as unknown as HTMLAudioElement, createToken, getContext: context, onSnapshot: (s) => snapshots.push(s), onMessage: (m) => messages.push(m), onProposal: proposal });
  return { voice, audio, track, createToken, fetcher, getUserMedia, snapshots, messages, proposal, context, channel: () => Peer.instances.at(-1)!.channel };
}
let current: ReturnType<typeof setup>;
beforeEach(() => { Peer.instances = []; current = setup(); });
afterEach(() => { current.voice.disconnect(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("voice connection lifecycle", () => {
  it("uses an ephemeral key, loads context, and releases only its own microphone", async () => {
    await current.voice.start();
    expect(current.fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({ headers: { Authorization: "Bearer ek_test", "Content-Type": "application/sdp" }, body: "test-offer" }));
    expect(current.channel().sent.find(event => event.session?.instructions)).toMatchObject({ type: "session.update", session: { instructions: expect.stringContaining("server instructions") } });
    expect(current.snapshots.at(-1)?.status).toBe("listening");
    current.voice.setMicMuted(true);
    expect(current.track.enabled).toBe(false);
    current.voice.setMicMuted(false);
    expect(current.track.enabled).toBe(true);
    current.voice.disconnect();
    expect(current.track.stop).toHaveBeenCalledOnce();
    expect(current.snapshots.at(-1)?.status).toBe("idle");
  });
  it("does not request paid access if microphone permission is denied", async () => {
    current.getUserMedia.mockRejectedValueOnce(new Error("Microfoon geweigerd"));
    await current.voice.start();
    expect(current.createToken).not.toHaveBeenCalled();
    expect(current.snapshots.at(-1)).toMatchObject({ status: "error", error: "Microfoon geweigerd" });
  });
  it("stops a late microphone result after cancellation without creating a session", async () => {
    let resolve!: (value: any) => void;
    current.getUserMedia.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const start = current.voice.start();
    current.voice.disconnect();
    const lateTrack = { stop: vi.fn() };
    resolve({ getTracks: () => [lateTrack] });
    await start;
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(current.createToken).not.toHaveBeenCalled();
  });
  it("cannot reopen after cancellation during token retrieval", async () => {
    let resolve!: (value: any) => void;
    current.createToken.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const start = current.voice.start();
    await vi.waitFor(() => expect(current.createToken).toHaveBeenCalled());
    current.voice.disconnect();
    resolve({ value: "ek_late", expiresAt: Date.now() / 1000 + 60, instructions: "", model: "test" });
    await start;
    expect(current.fetcher).not.toHaveBeenCalled();
    expect(current.track.stop).toHaveBeenCalledOnce();
  });
  it("cleans up after signaling failure", async () => {
    current.fetcher.mockResolvedValueOnce(new Response("failure", { status: 500 }));
    await current.voice.start();
    expect(current.track.stop).toHaveBeenCalledOnce();
    expect(current.snapshots.at(-1)?.status).toBe("error");
  });
  it("stops after five minutes", async () => {
    vi.useFakeTimers();
    await current.voice.start();
    vi.advanceTimersByTime(5 * 60_000);
    expect(current.track.stop).toHaveBeenCalledOnce();
    expect(current.snapshots.at(-1)?.status).toBe("idle");
  });
});

describe("live conversation", () => {
  it("interrupts audio immediately and clears server playback", async () => {
    await current.voice.start();
    const dc = current.channel();
    dc.event({ type: "response.created" });
    dc.event({ type: "output_audio_buffer.started" });
    current.voice.interrupt();
    expect(current.audio.muted).toBe(true);
    expect(dc.sent.slice(-2).map((e) => e.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    dc.event({ type: "output_audio_buffer.started" });
    expect(current.audio.muted).toBe(true);
    // Late response.created after cancellation must stay muted too.
    dc.event({ type: "response.created" });
    dc.event({ type: "output_audio_buffer.started" });
    expect(current.audio.muted).toBe(true);
    current.voice.sendText("Nieuwe vraag");
    dc.event({ type: "response.done", response: {status:"cancelled",output:[]} });
    dc.event({ type: "response.created" });
    dc.event({ type: "output_audio_buffer.started" });
    expect(current.audio.muted).toBe(false);
  });
  it("lets VAD handle automatic cancellation without a duplicate response.cancel", async () => {
    await current.voice.start();
    const dc = current.channel();
    dc.event({ type: "response.created" });
    dc.event({ type: "input_audio_buffer.speech_started" });
    expect(dc.sent.some((e) => e.type === "response.cancel")).toBe(false);
  });
  it("keeps speaking status until playback finishes, even when generation is done", async () => {
    await current.voice.start();
    const dc = current.channel();
    dc.event({ type: "output_audio_buffer.started" });
    dc.event({ type: "response.done", response: { status: "completed", output: [] } });
    expect(current.snapshots.at(-1)?.status).toBe("speaking");
    dc.event({ type: "output_audio_buffer.stopped" });
    expect(current.snapshots.at(-1)?.status).toBe("listening");
  });
  it("keeps conversation transcripts separate and accepts typed follow-up questions", async () => {
    await current.voice.start();
    const dc = current.channel();
    dc.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Wat is besloten?" });
    dc.event({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "We starten " });
    dc.event({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "We starten vrijdag." });
    expect(current.messages.at(-1)).toMatchObject({ role: "assistant", text: "We starten vrijdag.", final: true });
    current.voice.sendText("  Wie doet dat?  ");
    expect(current.messages.at(-1)).toMatchObject({ role: "user", text: "Wie doet dat?" });
    expect(dc.sent.at(-1)?.type).toBe("response.create");
  });
  it("only proposes edits from a completed tool call and never persists notes itself", async () => {
    await current.voice.start();
    const dc = current.channel();
    const output = [{ type: "function_call", call_id: "call-1", name: "propose_action_item_update", arguments: JSON.stringify({ notesRevision: "revision-1", itemIndex: 0, description: "Planning", owner: "Mark", deadline: "Donderdag" }) }];
    dc.event({ type: "response.done", response: { status: "cancelled", output } });
    expect(current.proposal).not.toHaveBeenCalled();
    dc.event({ type: "response.done", response: { status: "completed", output } });
    expect(current.proposal).toHaveBeenCalledOnce();
    expect(dc.sent.at(-2)).toMatchObject({ item: { type: "function_call_output", output: expect.stringContaining("wacht op bevestiging") } });
  });
  it("updates context only when it changes", async () => {
    await current.voice.start();
    const length = current.channel().sent.length;
    current.voice.updateContext();
    expect(current.channel().sent).toHaveLength(length);
    current.context.mockReturnValue('{"meetingId":"meeting-1","notes":"new"}');
    current.voice.updateContext();
    expect(current.channel().sent).toHaveLength(length + 1);
  });
});

it("uses an isolated clone of the meeting microphone without requesting a second device", async () => {
  const track = { enabled: true, stop: vi.fn() };
  const clone = { getTracks: () => [track], getAudioTracks: () => [track] };
  const voice = new VoiceSession({ audio: current.audio as unknown as HTMLAudioElement,
    createToken: current.createToken, getContext: current.context, getMicrophone: () => clone as unknown as MediaStream,
    onSnapshot: () => {}, onMessage: () => {}, onProposal: () => "pending" });
  await voice.start();expect(current.getUserMedia).not.toHaveBeenCalled();
  voice.disconnect();expect(track.stop).toHaveBeenCalledOnce();expect(current.track.stop).not.toHaveBeenCalled();
});


describe("app-controlled meeting speech", () => {
  it("keeps the cloned microphone muted and never enables automatic responses", async () => {
    expect(await current.voice.speakControlled("Wie bestelt de kleding?", () => true)).toBe(true);
    expect(current.track.enabled).toBe(false);
    const config = current.channel().sent.find(event => event.session?.audio);
    expect(config!.session.audio.input.turn_detection.create_response).toBe(false);
    expect(current.channel().sent.filter(event => event.type === "response.create")).toHaveLength(1);
    await current.voice.start();
    expect(current.track.enabled).toBe(true);
    expect(current.snapshots.at(-1)?.controlled).toBe(false);
  });
  it("rechecks permission after connecting and drops obsolete speech", async () => {
    let allowed = true;
    current.createToken.mockImplementationOnce(async () => {
      allowed = false;
      return { value: "ek_test", expiresAt: Date.now()/1000+60, model: "test", instructions: "test" };
    });
    expect(await current.voice.speakControlled("Oude vraag", () => allowed)).toBe(false);
    expect(current.channel().sent.some(event => event.type === "response.create")).toBe(false);
  });
  it("returns promptly if a controlled connection fails", async () => {
    current.createToken.mockRejectedValueOnce(new Error("Geen toegang"));
    expect(await current.voice.speakControlled("Vraag", () => true)).toBe(false);
    expect(current.snapshots.at(-1)?.status).toBe("error");
  });
  it("cancels a requested response even before response.created arrives", async () => {
    await current.voice.speakControlled("Vraag", () => true);
    current.voice.interrupt();
    expect(current.channel().sent.at(-1)?.type).toBe("response.cancel");
    current.channel().event({type: "response.created"});
    current.channel().event({type: "output_audio_buffer.started"});
    expect(current.audio.muted).toBe(true);
  });
});


describe("Realtime request contract and user-visible messages", () => {
  it("uses valid client item IDs for typed and controlled input", async () => {
    await current.voice.start();current.voice.sendText("Wat is er besproken?");
    const event=current.channel().sent.find(e=>e.type==="conversation.item.create" && e.item.id);
    expect(event!.item.id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/);
    expect(current.messages.at(-1)).toMatchObject({id:event!.item.id,text:"Wat is er besproken?",role:"user"});
  });
  it("keeps internal speech instructions out of the chat and shows the actual spoken request", async () => {
    await current.voice.speakControlled("Zeg alleen: Ja?",()=>true,"Kneut?");
    expect(current.messages.filter(m=>m.role==="user").map(m=>m.text)).toEqual(["Kneut?"]);
    expect(JSON.stringify(current.channel().sent)).toContain("Zeg alleen: Ja?");
    current.channel().event({type:"response.done",response:{status:"completed",output:[]}});
    await current.voice.speakControlled("Stel uitsluitend deze verduidelijkingsvraag: Wie regelt dit?",()=>true);
    expect(current.messages.filter(m=>m.role==="user").map(m=>m.text)).toEqual(["Kneut?"]);
  });
  it("waits for cancellation acknowledgement before requesting the next answer",async()=>{
    await current.voice.start();current.voice.sendText("Eerste vraag");current.channel().event({type:"response.created"});
    current.voice.sendText("Volgende vraag");
    expect(current.channel().sent.filter(e=>e.type==="response.create")).toHaveLength(1);
    expect(current.channel().sent.some(e=>e.type==="response.cancel")).toBe(true);
    current.channel().event({type:"response.done",response:{status:"cancelled",output:[]}});
    expect(current.channel().sent.filter(e=>e.type==="response.create")).toHaveLength(2);
  });
  it("does not start a queued question after the user cancels it",async()=>{
    await current.voice.start();current.voice.sendText("Eerste vraag");current.voice.sendText("Nieuwe vraag");current.voice.interrupt();
    current.channel().event({type:"response.done",response:{status:"cancelled",output:[]}});
    expect(current.channel().sent.filter(e=>e.type==="response.create")).toHaveLength(1);
  });
  it("retains safe diagnostic fields and correlates the failing event, without exposing raw errors",async()=>{
    await current.voice.start();current.voice.sendText("Vraag");const request=current.channel().sent.find(e=>e.type==="conversation.item.create");
    current.channel().event({type:"error",error:{code:"invalid_value",param:"item.id",event_id:request!.event_id,message:"private upstream detail sk_private"}});
    expect(current.snapshots.at(-1)).toMatchObject({status:"error",diagnostic:{code:"invalid_value",parameter:"item.id",event:"conversation.item.create"}});
    expect(JSON.stringify(current.snapshots)).not.toContain("sk_private");
  });
});

it("starts a microphone-enabled dialogue with the wake question as text",async()=>{
 expect(await current.voice.startDialogue("Wat is besproken?","Kneut, wat is besproken?")).toBe(true);
 expect(current.track.enabled).toBe(true);expect(current.snapshots.at(-1)?.controlled).toBe(false);
 expect(current.channel().sent.find(e=>e.session?.audio)?.session.audio.input.turn_detection.create_response).toBe(true);
 expect(current.messages.at(-1)?.text).toBe("Kneut, wat is besproken?");
});

it("reports detected user speech for the character and clears it on mute and disconnect",async()=>{
 await current.voice.start();current.channel().event({type:"input_audio_buffer.speech_started"});expect(current.snapshots.at(-1)?.userSpeaking).toBe(true);
 current.voice.setMicMuted(true);expect(current.snapshots.at(-1)?.userSpeaking).toBe(false);
 current.voice.setMicMuted(false);current.channel().event({type:"input_audio_buffer.speech_started"});current.channel().event({type:"input_audio_buffer.speech_stopped"});expect(current.snapshots.at(-1)?.userSpeaking).toBe(false);
 current.voice.disconnect();expect(current.snapshots.at(-1)?.userSpeaking).toBe(false);
});
