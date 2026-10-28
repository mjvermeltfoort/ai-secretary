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
    expect(current.channel().sent[0]).toMatchObject({ type: "session.update", session: { instructions: expect.stringContaining("server instructions") } });
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
