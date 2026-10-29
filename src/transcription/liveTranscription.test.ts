import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LocalSegment } from "../recording/localSegmentStore";
import type { MeetingCheckpoint } from "../recording/meetingCheckpoint";
import { SAMPLE_RATE, wav } from "../recording/pcm";
const token=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("firebase/functions",()=>({httpsCallable:()=>token.create}));vi.mock("../lib/firebase",()=>({functions:{}}));
import { LiveTranscription } from "./liveTranscription";
class Socket {
 static all:Socket[]=[];readyState=1;bufferedAmount=0;onmessage?:({data}:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;sent:any[]=[];
 constructor(public url:string,public protocols:string[]){Socket.all.push(this);}
 send(text:string){this.sent.push(JSON.parse(text));}close(){this.readyState=3;this.onclose?.();}event(event:unknown){this.onmessage?.({data:JSON.stringify(event)});}
}
let live:LiveTranscription, results:any[],states:string[],restored:any[],segments:LocalSegment[],checkpoint:MeetingCheckpoint|undefined;
let store:{
 list:Mock<(id:string)=>Promise<LocalSegment[]>>;
 put:Mock<(segment:LocalSegment)=>Promise<void>>;
 loadMeeting:Mock<(id:string)=>Promise<MeetingCheckpoint|undefined>>;
 saveMeeting:Mock<(id:string,patch:Partial<Omit<MeetingCheckpoint,"id"|"updatedAt">>)=>Promise<void>>;
};
const voice=(seconds:number)=>new Int16Array(seconds*SAMPLE_RATE).fill(1000);
const quiet=(seconds:number)=>new Int16Array(seconds*SAMPLE_RATE);
function add(samples:Int16Array) {
 const segment:LocalSegment={id:`m-${segments.length+1}`,meetingId:"m",sequence:segments.length+1,createdAt:Date.now()+samples.length/24,durationMs:samples.length/24,blob:wav(samples)};
 segments.push(segment);live.notifySavedAudio(segment);return segment;
}
function open() {const ws=Socket.all.at(-1)!;ws.event({type:"session.created"});return ws;}
const committed=(ws:Socket)=>ws.sent.filter(e=>e.type==="input_audio_buffer.commit").length;
async function ack(ws:Socket,id="turn",text="Afspraak") {
 ws.event({type:"input_audio_buffer.committed",item_id:id});ws.event({type:"conversation.item.input_audio_transcription.completed",item_id:id,transcript:text});
 await vi.waitFor(()=>expect(checkpoint?.live?.turns.some(t=>t.text===text)).toBe(true));
}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
 vi.stubGlobal("WebSocket",Socket);Socket.all=[];token.create.mockReset();token.create.mockImplementation(async()=>({data:{value:"ek_test",expiresAt:Date.now()/1000+60}}));
 segments=[];checkpoint=undefined;results=[];states=[];restored=[];
 store={list:vi.fn(async()=>segments),put:vi.fn(async()=>{}),loadMeeting:vi.fn(async()=>checkpoint),saveMeeting:vi.fn(async(id,patch)=>{checkpoint=structuredClone({...checkpoint,...patch,id,updatedAt:Date.now()});})};
 live=new LiveTranscription("m",r=>results.push(r),s=>states.push(s),{store,onRestore:r=>{restored=r;},retryDelay:()=>1000});
});
afterEach(()=>{live.close();vi.unstubAllGlobals();vi.useRealTimers();});

it("commits at a natural pause across storage boundaries, without opening another session",async()=>{
 await live.start();const ws=open();add(voice(15));await vi.waitFor(()=>expect(ws.sent.length).toBeGreaterThan(100));expect(committed(ws)).toBe(0);
 add(quiet(1));await vi.waitFor(()=>expect(committed(ws)).toBe(1));await ack(ws);
 expect(Socket.all).toHaveLength(1);expect(ws.protocols).toContain("openai-insecure-api-key.ek_test");
 expect(checkpoint!.live!.cursor).toBe(15.9*SAMPLE_RATE);expect(checkpoint!.live!.turns).toHaveLength(1);
});
it("replays an unacknowledged turn after disconnect using the same sequence",async()=>{
 await live.start();const first=open();add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(first)).toBe(1));
 first.event({type:"conversation.item.input_audio_transcription.delta",item_id:"old",delta:"Voorlopig"});const sequence=results.at(-1).sequence;
 first.close();expect(states.at(-1)).toBe("offline");expect(checkpoint?.live?.turns??[]).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(1000);const second=open();await vi.waitFor(()=>expect(committed(second)).toBe(1));await ack(second,"new","Definitief");
 expect(checkpoint!.live!.turns).toHaveLength(1);expect(checkpoint!.live!.turns[0]).toMatchObject({sequence,text:"Definitief",replayed:true});
 expect(first.sent.filter(e=>e.type==="input_audio_buffer.append").map(e=>e.audio)).toEqual(second.sent.filter(e=>e.type==="input_audio_buffer.append").map(e=>e.audio));
});
it("persists final text before advancing, and ignores duplicate final events",async()=>{
 await live.start();const ws=open();add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));
 let finish!:()=>void;const original=store.saveMeeting.getMockImplementation()!;
 store.saveMeeting.mockImplementationOnce((...args)=>new Promise<void>(resolve=>{finish=()=>{void original(...args).then(resolve);};}));
 const event={type:"conversation.item.input_audio_transcription.completed",item_id:"same",transcript:"Een afspraak"};
 ws.event({type:"input_audio_buffer.committed",item_id:"same"});ws.event(event);ws.event(event);
 await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));expect(results.filter(r=>r.liveFinal)).toHaveLength(0);
 finish();await vi.waitFor(()=>expect(results.filter(r=>r.liveFinal)).toHaveLength(1));expect(checkpoint!.live!.nextSequence).toBe(1000001);
});
it("does not publish final text if checkpoint storage fails",async()=>{
 await live.start();const ws=open();add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));
 store.saveMeeting.mockRejectedValueOnce(new Error("quota"));ws.event({type:"conversation.item.input_audio_transcription.completed",item_id:"id",transcript:"Afspraak"});
 await vi.waitFor(()=>expect(states.at(-1)).toBe("blocked"));expect(results.filter(r=>r.liveFinal)).toHaveLength(0);expect(segments).toHaveLength(1);
});
it("restores completed text after a page reload and never resends acknowledged speech",async()=>{
 await live.start();let ws=open();add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));await ack(ws,"first","Eerste");
 live.close();live=new LiveTranscription("m",r=>results.push(r),s=>states.push(s),{store,onRestore:r=>{restored=r;}});
 await live.start();ws=open();await vi.waitFor(()=>expect(restored[0]).toMatchObject({text:"Eerste",replayed:true}));
 add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));await ack(ws,"second","Tweede");
 expect(checkpoint!.live!.turns.map(t=>t.text)).toEqual(["Eerste","Tweede"]);expect(checkpoint!.live!.turns[1].audioStartSample).toBeGreaterThanOrEqual(checkpoint!.live!.turns[0].audioEndSample!);
});
it("rotates only after an in-flight turn is saved",async()=>{
 live=new LiveTranscription("m",r=>results.push(r),s=>states.push(s),{store,rotationMs:1000});
 await live.start();let ws=open();add(voice(1));await vi.waitFor(()=>expect(ws.sent.length).toBeGreaterThan(0));
 await vi.advanceTimersByTimeAsync(1000);expect(Socket.all).toHaveLength(1);
 add(quiet(1));await vi.waitFor(()=>expect(committed(ws)).toBe(1));await ack(ws);
 expect(Socket.all).toHaveLength(1);await vi.advanceTimersByTimeAsync(5000);
 await vi.waitFor(()=>expect(Socket.all).toHaveLength(2));ws=open();expect(checkpoint!.live!.turns).toHaveLength(1);
});
it("backs off repeatedly and does not reconnect after close",async()=>{
 token.create.mockRejectedValue(new Error("offline"));await live.start();expect(token.create).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(3000);expect(token.create).toHaveBeenCalledTimes(4);live.close();
 await vi.advanceTimersByTimeAsync(10000);expect(token.create).toHaveBeenCalledTimes(4);
});
it("does not open a late socket after cancellation",async()=>{
 let resolve!:(value:unknown)=>void;token.create.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const start=live.start();await vi.waitFor(()=>expect(resolve).toBeTypeOf("function"));live.close();
 resolve({data:{value:"ek_late",expiresAt:Date.now()/1000+60}});await start;expect(Socket.all).toHaveLength(0);
});
it("limits network buffering by reconnecting and keeps the source on disk",async()=>{
 await live.start();const ws=open();ws.bufferedAmount=2000000;add(voice(1));
 await vi.waitFor(()=>expect(states.at(-1)).toBe("offline"));expect(segments).toHaveLength(1);expect(checkpoint?.live?.cursor??0).toBe(0);
});
it("refuses gaps and corrupt audio without inventing a complete live transcript",async()=>{
 segments=[{id:"m-2",meetingId:"m",sequence:2,createdAt:1,durationMs:1000,blob:wav(voice(1))}];
 await live.start();expect(states.at(-1)).toBe("blocked");expect(token.create).not.toHaveBeenCalled();
});
it("continues from a durably saved final result even if disconnect happens during saving",async()=>{
 await live.start();const ws=open();add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));
 let finish!:()=>void;const original=store.saveMeeting.getMockImplementation()!;
 store.saveMeeting.mockImplementationOnce((...args)=>new Promise<void>(resolve=>{finish=()=>{void original(...args).then(resolve);};}));
 ws.event({type:"conversation.item.input_audio_transcription.completed",item_id:"id",transcript:"Bewaard"});
 await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));ws.close();await vi.advanceTimersByTimeAsync(1000);expect(Socket.all).toHaveLength(1);
 finish();await vi.waitFor(()=>expect(Socket.all).toHaveLength(2));open();expect(restored[0]).toMatchObject({text:"Bewaard",replayed:true});
});

it("keeps rotating and recording stable turn identities across four hours of virtual time",async()=>{
 await live.start();let ws=open();
 for(let i=0;i<12;i++) {
  add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBeGreaterThan(0));await ack(ws,`turn-${i}`,`Afspraak ${i}`);
  await vi.advanceTimersByTimeAsync(20*60*1000);ws=open();
 }
 expect(Socket.all.length).toBeGreaterThanOrEqual(13);expect(checkpoint!.live!.turns).toHaveLength(12);
 expect(new Set(checkpoint!.live!.turns.map(t=>t.sequence)).size).toBe(12);
 expect(checkpoint!.live!.turns.every((t,i,a)=>i===0 || t.audioStartSample!>=a[i-1].audioEndSample!)).toBe(true);
},15000);
it("can restart while an old page-load request is being cancelled",async()=>{
 let resolve!:(value:undefined)=>void;store.loadMeeting.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const first=live.start();live.close();const second=live.start();resolve(undefined);await first;await second;
 expect(Socket.all).toHaveLength(1);open();
});

it("does not label a new question as replay just because its silence preroll is old",async()=>{
 add(quiet(2));await live.start();const ws=open();await vi.waitFor(()=>expect(store.saveMeeting).toHaveBeenCalled());
 add(new Int16Array([...voice(1),...quiet(1)]));await vi.waitFor(()=>expect(committed(ws)).toBe(1));await ack(ws,"fresh","Nieuwe vraag");
 expect(checkpoint!.live!.turns[0].replayed).toBe(false);
});
