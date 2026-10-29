import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
const rig = vi.hoisted(() => ({ records: new Map<string, any>(), generate: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({
  Timestamp: { now: () => new Date() },
  getFirestore: () => ({ doc: (path: string) => ({path}), runTransaction: async (fn: any) => fn({
    get: async (ref: any) => ({data: () => rig.records.get(ref.path)}),
    set: (ref: any, data: any) => rig.records.set(ref.path, {...rig.records.get(ref.path), ...data}),
  }) }),
}));
vi.mock("openai", () => ({default: class {responses = {create: rig.generate};},toFile: vi.fn()}));
import { assessMeetingClarity } from "../functions/src/index";
const auth = {uid:"owner",token:{email:"mjvermeltfoort@gmail.com",email_verified:true,firebase:{sign_in_provider:"google.com"}}};
const request = (text: string, meetingId = "m1") => ({auth,data:{meetingId,text}} as CallableRequest);
const target = "users/owner/meetings/m1/kneut/latest";
beforeEach(() => {
  rig.records.clear();rig.generate.mockReset();vi.stubEnv("OPENAI_API_KEY","test-not-a-real-key");
  rig.generate.mockResolvedValue({output_text:JSON.stringify({questions:[{id:"",question:"Wie bestelt?",evidence:"We bestellen kleding."}],transition:false})});
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
});
afterEach(() => {vi.useRealTimers();vi.unstubAllEnvs();});
describe("clarity callable persistence and throttling", () => {
  it("caches identical text without another paid request and preserves owner scope", async () => {
    const first = await assessMeetingClarity.run(request("We bestellen kleding."));
    expect(await assessMeetingClarity.run(request("We bestellen kleding."))).toEqual(first);
    expect(rig.generate).toHaveBeenCalledOnce();expect([...rig.records.keys()]).toEqual([target]);
    expect(rig.records.get(target).leaseUntil).toBe(0);
  });
  it("blocks overlapping work and releases the lease after a failure", async () => {
    let reject!: (cause: Error) => void;
    rig.generate.mockImplementationOnce(() => new Promise((_resolve, fail) => {reject=fail;}));
    const first = assessMeetingClarity.run(request("We bestellen kleding."));
    await vi.waitFor(() => expect(rig.generate).toHaveBeenCalledOnce());
    vi.advanceTimersByTime(13000);
    await expect(assessMeetingClarity.run(request("We bestellen kleding. Mark regelt het."))).rejects.toMatchObject({code:"resource-exhausted"});
    reject(new Error("upstream private error"));
    await expect(first).rejects.toMatchObject({code:"unavailable"});expect(rig.records.get(target).leaseUntil).toBe(0);
    const result = await assessMeetingClarity.run(request("We bestellen kleding. Mark regelt het."));
    expect(result.questions).toHaveLength(1);
  });
  it("passes existing questions to the next review and persists their resolution", async () => {
    await assessMeetingClarity.run(request("We bestellen kleding."));vi.advanceTimersByTime(13000);
    rig.generate.mockResolvedValueOnce({output_text:'{"questions":[],"transition":true}'});
    await assessMeetingClarity.run(request("We bestellen kleding. Mark bestelt. Akkoord, volgende punt."));
    expect(JSON.parse(rig.generate.mock.calls[1][0].input).previousQuestions).toHaveLength(1);
    expect(rig.records.get(target).assessment.questions).toEqual([]);
  });
});
