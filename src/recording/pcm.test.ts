import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { PcmSegmenter, pcm16, readWav, wav } from "./pcm";
describe("continuous PCM storage",()=>{
  it("preserves every sample across arbitrary input and save boundaries",async()=>{
    const pieces:Int16Array[]=[];const buffer=new PcmSegmenter(7,p=>pieces.push(p));
    const input=Int16Array.from({length:103},(_,i)=>i-50);
    buffer.push(input.slice(0,3));buffer.push(input.slice(3,62));buffer.push(input.slice(62));buffer.flush();buffer.flush();
    expect(pieces.flatMap(p=>[...p])).toEqual([...input]);
    for(const piece of pieces)expect([...(await readWav(wav(piece)))]).toEqual([...piece]);
  });
  it("clamps PCM and rejects invalid file metadata",async()=>{
    expect([...pcm16(new Float32Array([-2,-1,0,1,2]))]).toEqual([-32768,-32768,0,32767,32767]);
    await expect(readWav(new Blob(["not wav"]))).rejects.toThrow();
  });
  it("worklet keeps running across flushes and pauses without restarting the audio source",()=>{
    let Processor:any;const sent:any[]=[];
    const context={Float32Array,AudioWorkletProcessor:class{port={onmessage:null as any,postMessage:(value:any)=>sent.push(value)};},registerProcessor:(_name:string,cls:any)=>{Processor=cls;}};
    vm.runInNewContext(readFileSync("public/pcm-recorder-worklet.js","utf8"),context);
    const node=new Processor();
    node.process([[new Float32Array([.1,.2,.3])]]);
    node.port.onmessage({data:{type:"pause",id:1}});
    node.process([[new Float32Array([.9])]]);
    node.port.onmessage({data:{type:"resume"}});
    node.process([[new Float32Array([.4,.5])]]);
    node.port.onmessage({data:{type:"flush",id:2}});
    const samples=sent.filter(x=>x.type==="samples").flatMap(x=>[...x.samples]);
    expect(samples.map(x=>Math.round(x*10))).toEqual([1,2,3,4,5]);
    expect(sent.filter(x=>x.type==="flushed").map(x=>x.id)).toEqual([1,2]);
  });
});
