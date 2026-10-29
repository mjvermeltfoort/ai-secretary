import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { BrowserRecorder } from "./browserRecorder";
import { readWav } from "./pcm";
import type { LocalSegment } from "./localSegmentStore";
class Node {
 static latest:Node;port={onmessage:undefined as undefined|((event:any)=>void),postMessage:(data:any)=>queueMicrotask(()=>this.port.onmessage?.({data:{type:"flushed",id:data.id}}))};
 connect=vi.fn();disconnect=vi.fn();constructor(){Node.latest=this;}
 emit(samples:Float32Array){this.port.onmessage?.({data:{type:"samples",samples}});}
}
class Context {
 static all:Context[]=[];state="running";listener?:()=>void;addEventListener=(_type:string,listener:()=>void)=>{this.listener=listener;};sampleRate=24000;audioWorklet={addModule:async()=>{}};destination={};
 createMediaStreamSource=()=>({connect:vi.fn(),disconnect:vi.fn()});createGain=()=>({gain:{value:0},connect:vi.fn(),disconnect:vi.fn()});
 resume=vi.fn(async()=>{});close=vi.fn(async()=>{});constructor(){Context.all.push(this);}
}
let ended:()=>void;let track:{stop:ReturnType<typeof vi.fn>;addEventListener:(event:string,listener:()=>void)=>void};
let recorder:BrowserRecorder,segments:LocalSegment[],onError:Mock<(error:Error)=>void>,getUserMedia:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 Context.all=[];segments=[];onError=vi.fn();track={stop:vi.fn(),addEventListener:(_event,listener)=>{ended=listener;}};
 getUserMedia=vi.fn(async()=>({getTracks:()=>[track],getAudioTracks:()=>[track],clone:()=>({clone:true})}));
 vi.stubGlobal("navigator",{mediaDevices:{getUserMedia}});vi.stubGlobal("AudioContext",Context);vi.stubGlobal("AudioWorkletNode",Node);
 recorder=new BrowserRecorder({store:{list:async()=>segments,put:async(segment)=>{segments.push(segment);}},onError,onAudio:()=>{throw new Error("AI unavailable");}});
});
afterEach(async()=>{await recorder.stop().catch(()=>{});vi.unstubAllGlobals();});
it("preserves audio with a checksum even if the live consumer fails, and reuses one graph on resume",async()=>{
 await recorder.start("m");Node.latest.emit(new Float32Array(48000).fill(.5));await recorder.pause();
 expect(segments).toHaveLength(1);expect(segments[0].checksum).toMatch(/^[a-f0-9]{64}$/);expect((await readWav(segments[0].blob))[0]).toBe(16384);
 await recorder.start("m");Node.latest.emit(new Float32Array(2400).fill(.25));await recorder.stop();
 expect(Context.all).toHaveLength(1);expect(getUserMedia).toHaveBeenCalledOnce();expect(segments.map(s=>s.sequence)).toEqual([1,2]);
 expect(segments[1].startMs).toBe(2000);expect(track.stop).toHaveBeenCalledOnce();expect(onError).not.toHaveBeenCalled();
});
it("releases the microphone and preserves the prior segment if the device ends the track",async()=>{
 await recorder.start("m");Node.latest.emit(new Float32Array(48000));ended();
 await vi.waitFor(()=>expect(onError).toHaveBeenCalledOnce());expect(recorder.recordingState.status).toBe("stopped");expect(segments).toHaveLength(1);
});
it("appends new audio to an existing stopped meeting after reload",async()=>{
 await recorder.start("m");Node.latest.emit(new Float32Array(48000));await recorder.stop();
 await recorder.start("m");Node.latest.emit(new Float32Array(48000));await recorder.stop();
 expect(segments.map(s=>s.sequence)).toEqual([1,2]);expect(segments[1].startMs).toBe(2000);
});

it("marks an unexpected browser suspension as an interruption and saves the known tail",async()=>{
 await recorder.start("m");Node.latest.emit(new Float32Array(2400));Context.all[0].state="suspended";Context.all[0].listener?.();
 await vi.waitFor(()=>expect(onError).toHaveBeenCalledOnce());expect(recorder.recordingState.status).toBe("stopped");expect(segments[0].durationMs).toBe(100);
});
