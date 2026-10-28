import { afterEach, beforeEach, expect, it, vi } from "vitest";
const token=vi.hoisted(()=>({create:vi.fn()}));
vi.mock("firebase/functions",()=>({httpsCallable:()=>token.create}));vi.mock("../lib/firebase",()=>({functions:{}}));
import { LiveTranscription } from "./liveTranscription";
class Socket {
 static last:Socket;readyState=1;bufferedAmount=0;onmessage?:({data}:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;sent:any[]=[];
 constructor(public url:string,public protocols:string[]){Socket.last=this;}
 send(text:string){this.sent.push(JSON.parse(text));}close(){this.onclose?.();}event(event:unknown){this.onmessage?.({data:JSON.stringify(event)});}
}
let live:LiveTranscription;let results:any[];let states:string[];
beforeEach(()=>{vi.stubGlobal("WebSocket",Socket);token.create.mockResolvedValue({data:{value:"ek_test",expiresAt:Date.now()/1000+60}});results=[];states=[];live=new LiveTranscription("m",r=>results.push(r),s=>states.push(s));});
afterEach(()=>{live.close();vi.unstubAllGlobals();});
it("commits at a natural pause rather than storage boundaries",async()=>{
 await live.start();const ws=Socket.last;ws.event({type:"session.created"});
 for(let i=0;i<150;i++)live.push(new Int16Array(2400).fill(1000));
 expect(ws.sent.some(e=>e.type==="input_audio_buffer.commit")).toBe(false);
 for(let i=0;i<9;i++)live.push(new Int16Array(2400));
 expect(ws.sent.filter(e=>e.type==="input_audio_buffer.commit")).toHaveLength(1);
 expect(ws.protocols).toContain("openai-insecure-api-key.ek_test");
});
it("keeps transcript order even if final text completes out of order",async()=>{
 await live.start();const ws=Socket.last;ws.event({type:"session.created"});
 ws.event({type:"input_audio_buffer.committed",item_id:"a"});ws.event({type:"input_audio_buffer.committed",item_id:"b"});
 ws.event({type:"conversation.item.input_audio_transcription.completed",item_id:"b",transcript:"Tweede"});
 ws.event({type:"conversation.item.input_audio_transcription.completed",item_id:"a",transcript:"Eerste"});
 expect([...results].sort((a,b)=>a.sequence-b.sequence).map(r=>r.text)).toEqual(["Eerste","Tweede"]);
 expect(results.every(r=>r.provisional)).toBe(true);
});
it("fails closed on excessive network buffering without touching any recorder",async()=>{
 await live.start();Socket.last.event({type:"session.created"});Socket.last.bufferedAmount=2000000;
 live.push(new Int16Array(2400));expect(states.at(-1)).toBe("offline");
});
it("does not open a late socket after cancellation",async()=>{
 let resolve!:(value:unknown)=>void;token.create.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const start=live.start();live.close();const previous=Socket.last;
 resolve({data:{value:"ek_late",expiresAt:Date.now()/1000+60}});await start;expect(Socket.last).toBe(previous);
});
