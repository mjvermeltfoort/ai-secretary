import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
const rig=vi.hoisted(()=>({records:new Map<string,any>(),generate:vi.fn()}));
vi.mock("firebase-admin/firestore",()=>({Timestamp:{now:()=>new Date()},getFirestore:()=>({doc:(path:string)=>({path}),runTransaction:async(fn:any)=>fn({get:async(ref:any)=>({data:()=>rig.records.get(ref.path)}),set:(ref:any,data:any,options?:any)=>rig.records.set(ref.path,options?.merge?{...rig.records.get(ref.path),...data}:data)})})}));
vi.mock("openai",()=>({default:class{responses={create:rig.generate};},toFile:vi.fn()}));
import { summarizeVoiceContext } from "../functions/src/index";
import { validateBriefingInput } from "../functions/src/voiceBriefing";
const owner={uid:"owner",token:{email:"mjvermeltfoort@gmail.com",email_verified:true,firebase:{sign_in_provider:"google.com"}}};
const input={meetingId:"m",runId:`brief-${"a".repeat(64)}`,sequence:1,total:2,text:"We hebben kleding besproken."};
const req=(data:any=input,auth:any=owner)=>({auth,data} as CallableRequest);
beforeEach(()=>{rig.records.clear();rig.generate.mockReset();rig.generate.mockResolvedValue({output_text:"Algemeen: kleding besproken. Besluit: bestellen."});vi.stubEnv("OPENAI_API_KEY","test-key");});
afterEach(()=>vi.unstubAllEnvs());
describe("voice briefing callable",()=>{
 it("rejects unauthorized access and malformed inputs before AI work",async()=>{
  await expect(summarizeVoiceContext.run(req(input,null))).rejects.toMatchObject({code:"unauthenticated"});
  await expect(summarizeVoiceContext.run(req(input,{...owner,token:{...owner.token,email:"other@example.com"}}))).rejects.toMatchObject({code:"permission-denied"});
  for(const value of [null,{}, {...input,sequence:0},{...input,total:41},{...input,text:"a".repeat(24001)},{...input,meetingId:"../other"}])expect(()=>validateBriefingInput(value)).toThrow();
  expect(rig.generate).not.toHaveBeenCalled();
 });
 it("caches identical parts, preserves the previous summary and enforces order",async()=>{
  await expect(summarizeVoiceContext.run(req({...input,sequence:2}))).rejects.toMatchObject({code:"failed-precondition"});
  const first=await summarizeVoiceContext.run(req());expect(await summarizeVoiceContext.run(req())).toEqual(first);expect(rig.generate).toHaveBeenCalledOnce();
  await summarizeVoiceContext.run(req({...input,sequence:2,text:"Mark gaat het bestellen."}));
  expect(JSON.parse(rig.generate.mock.calls[1][0].input).previousSummary).toBe(first.summary);
  expect([...rig.records.keys()].every(p=>p.startsWith("users/owner/meetings/m/"))).toBe(true);
  await expect(summarizeVoiceContext.run(req({...input,text:"Andere bron"}))).rejects.toMatchObject({code:"already-exists"});
 });
 it("releases a failed processing lease without exposing upstream errors",async()=>{
  rig.generate.mockRejectedValueOnce(new Error("private API data"));await expect(summarizeVoiceContext.run(req())).rejects.toMatchObject({code:"unavailable"});
  expect([...rig.records.values()][0].leaseUntil).toBe(0);await expect(summarizeVoiceContext.run(req())).resolves.toHaveProperty("summary");
 });
});
