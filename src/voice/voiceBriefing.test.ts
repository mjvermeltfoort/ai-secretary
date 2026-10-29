import { beforeEach, describe, expect, it, vi } from "vitest";
const rig=vi.hoisted(()=>({call:vi.fn()}));vi.mock("firebase/functions",()=>({httpsCallable:()=>rig.call}));vi.mock("../lib/firebase",()=>({functions:{}}));
import { briefingChunks, prepareVoiceBriefing } from "./voiceBriefing";
beforeEach(()=>{rig.call.mockReset();rig.call.mockResolvedValue({data:{summary:"Algemeen: kleding besproken. Besluit: bestellen."}});});
describe("voice briefing preparation",()=>{
 it("summarizes all completed available text in bounded ordered parts, not only the recent tail",async()=>{
  const text=("Eerste onderwerp. ").repeat(4000)+" Laatste afspraak: Mark regelt het.";
  const result=await prepareVoiceBriefing("m",[{meetingId:"m",sequence:1,text,model:"test",provisional:true,liveFinal:true}],()=>true,vi.fn());
  expect(rig.call.mock.calls.length).toBeGreaterThan(1);expect(rig.call.mock.calls[0][0].text).toContain("Eerste onderwerp");
  expect(rig.call.mock.calls.at(-1)![0].text).toContain("Laatste afspraak");
  expect(rig.call.mock.calls.every(([input])=>input.text.length<=24000)).toBe(true);expect(result.sourceText).toBe(text);expect(result.provisional).toBe(true);
 });
 it("reuses a stable source identifier and never calls AI for empty text",async()=>{
  await prepareVoiceBriefing("m",[],()=>true,vi.fn());expect(rig.call).not.toHaveBeenCalled();
  const source=[{meetingId:"m",sequence:1,text:"Kleding besproken.",model:"test"}];
  await prepareVoiceBriefing("m",source,()=>true,vi.fn());await prepareVoiceBriefing("m",source,()=>true,vi.fn());
  expect(rig.call.mock.calls[0][0].runId).toBe(rig.call.mock.calls[1][0].runId);
 });
 it("does not process another part after cancellation and refuses malformed responses",async()=>{
  let allowed=true;rig.call.mockImplementationOnce(async()=>{allowed=false;return{data:{summary:"Korte tekst"}};});
  await expect(prepareVoiceBriefing("m",[{meetingId:"m",sequence:1,text:"woord ".repeat(10000),model:"test"}],()=>allowed,vi.fn())).rejects.toThrow("afgebroken");
  expect(rig.call).toHaveBeenCalledOnce();rig.call.mockResolvedValueOnce({data:{}});
  await expect(prepareVoiceBriefing("m",[{meetingId:"m",sequence:1,text:"tekst",model:"test"}],()=>true,vi.fn())).rejects.toThrow("bruikbare");
 });
 it("rejects an unbounded summary request",()=>expect(()=>briefingChunks("a".repeat(24000*41))).toThrow("te lang"));
});
