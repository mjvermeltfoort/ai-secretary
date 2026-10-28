import { describe, expect, it } from "vitest";
import type { CallableRequest } from "firebase-functions/v2/https";
import { createTranscriptionSession, transcribeAudioWindow, finalizeReviewedTranscript } from "../functions/src/index";
import { removeOverlap, validateWindow, verifyWav, validateReviewedWindows } from "../functions/src/transcription";
import { wav } from "../src/recording/pcm";
const owner={uid:"owner",token:{email:"mjvermeltfoort@gmail.com",email_verified:true,firebase:{sign_in_provider:"google.com"}}};
describe("transcription authorization",()=>{
  it.each([undefined,{...owner,token:{...owner.token,email:"other@gmail.com"}},{...owner,token:{...owner.token,email_verified:false}}])("denies unauthorized callers before storage or AI",async(auth)=>{
    for(const fn of [createTranscriptionSession,transcribeAudioWindow,finalizeReviewedTranscript])await expect(fn.run({auth,data:{}} as CallableRequest)).rejects.toMatchObject({code:auth?"permission-denied":"unauthenticated"});
  });
  it("rejects invalid owner requests before external work",async()=>{
    for(const fn of [createTranscriptionSession,transcribeAudioWindow,finalizeReviewedTranscript])await expect(fn.run({auth:owner,data:{}} as unknown as CallableRequest)).rejects.toMatchObject({code:"invalid-argument"});
  });
});
it("deduplicates a matching boundary and preserves uncertain overlap",()=>{
  expect(removeOverlap("We gaan op vrijdag starten.","op vrijdag starten. Mark maakt de planning.",true)).toEqual({text:"Mark maakt de planning.",overlapUncertain:false});
  expect(removeOverlap("Dit was gezegd.","Iets anders verstaan.",true)).toEqual({text:"Iets anders verstaan.",overlapUncertain:true});
  expect(removeOverlap("","Eerste zin.",false).text).toBe("Eerste zin.");
});
it("checks format, duration and bounded input",async()=>{
  const bytes=Buffer.from(await wav(new Int16Array(24000)).arrayBuffer());
  expect(()=>verifyWav(bytes,1000)).not.toThrow();expect(()=>verifyWav(bytes,2000)).toThrow();
  expect(()=>validateWindow({meetingId:"m",runId:"r",sequence:1,totalWindows:1,startMs:0,endMs:1000,audioBase64:bytes.toString("base64")})).not.toThrow();
  expect(()=>validateWindow({meetingId:"../m"})).toThrow();
});

it("publishes only complete, advancing and contiguous review windows",()=>{
 const first={sequence:1,totalWindows:2,startMs:0,endMs:60000,text:"Eerste"};const second={sequence:2,totalWindows:2,startMs:56000,endMs:80000,text:"Tweede"};
 expect(validateReviewedWindows([first,second],2)).toBe("Eerste\nTweede");
 for(const windows of [[first],[first,{...second,startMs:60000}],[first,{...second,endMs:59000}],[second,first]])expect(()=>validateReviewedWindows(windows,2)).toThrow();
});
