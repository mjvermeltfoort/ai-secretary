import { expect, it, vi } from "vitest";
import type { LocalSegment } from "./localSegmentStore";
import { readWav, wav } from "./pcm";
import { sha256, verifySegment, wavHeader, writeRecording } from "./exportRecording";
function segment(sequence:number,samples:Int16Array):LocalSegment{return{id:`m-${sequence}`,meetingId:"m",sequence,createdAt:1,durationMs:samples.length/24,blob:wav(samples)};}
it("exports the exact samples across segment boundaries with a single WAV header",async()=>{
 const first=segment(1,new Int16Array([1,2,-32768])),second=segment(2,new Int16Array([32767,5]));first.checksum=await sha256(first.blob);
 const exported=await writeRecording([second,first]);expect([...await readWav(exported!)]).toEqual([1,2,-32768,32767,5]);
});
it("writes one segment at a time to a streaming file destination",async()=>{
 const parts:BlobPart[]=[];const sink={write:vi.fn(async(data:Blob|Uint8Array)=>{parts.push(data);}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
 await writeRecording([segment(1,new Int16Array([1,2])),segment(2,new Int16Array([3]))],sink);
 expect(sink.write).toHaveBeenCalledTimes(3);expect(sink.close).toHaveBeenCalledOnce();expect(sink.abort).not.toHaveBeenCalled();
 expect([...await readWav(new Blob(parts))]).toEqual([1,2,3]);
});
it("refuses a gap, mismatched checksums and invalid WAV headers",async()=>{
 await expect(writeRecording([segment(2,new Int16Array([1]))])).rejects.toThrow("ontbreekt");
 const broken=segment(1,new Int16Array([1]));broken.checksum="wrong";await expect(verifySegment(broken)).rejects.toThrow("controlecode");
 broken.checksum=undefined;broken.blob=new Blob([new Uint8Array(44)]);await expect(verifySegment(broken)).rejects.toThrow("beschadigd");
});
it("aborts a failed streamed export and preserves all original blobs",async()=>{
 const source=segment(1,new Int16Array([1]));const sink={write:vi.fn(async()=>{throw new Error("disk full");}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
 await expect(writeRecording([source],sink)).rejects.toThrow("disk full");expect(sink.abort).toHaveBeenCalledOnce();expect(source.blob.size).toBe(46);
});
it("creates a four-hour WAV header without allocating four hours of PCM",()=>{
 const bytes=4*60*60*24000*2;const view=new DataView(wavHeader(bytes).buffer);
 expect(view.getUint32(40,true)).toBe(691200000);expect(view.getUint32(4,true)).toBe(bytes+36);
});

it("exports three hours of segment-backed audio with bounded PCM memory",async()=>{
 const shared=wav(new Int16Array(48000));
 const source=Array.from({length:5400},(_,i)=>({id:`m-${i+1}`,meetingId:"m",sequence:i+1,createdAt:i*2000,durationMs:2000,blob:shared}));
 let written=0;let maxPart=0;
 const sink={write:async(data:Blob|Uint8Array)=>{const size=data instanceof Blob?data.size:data.byteLength;written+=size;maxPart=Math.max(maxPart,size);},close:async()=>{},abort:async()=>{}};
 await writeRecording(source,sink);expect(written).toBe(3*60*60*24000*2+44);expect(maxPart).toBe(96000);
});
