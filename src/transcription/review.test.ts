import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("firebase/functions",()=>({httpsCallable:()=>vi.fn()}));vi.mock("../lib/firebase",()=>({functions:{}}));
import { audioWindows, windowRanges } from "./review";
import { readWav, SAMPLE_RATE, wav } from "../recording/pcm";
import type { LocalSegment } from "../recording/localSegmentStore";
afterEach(()=>vi.unstubAllGlobals());
it("uses 60-second windows with exactly four seconds overlap",()=>{
  expect(windowRanges(120*SAMPLE_RATE)).toEqual([{start:0,end:60*SAMPLE_RATE},{start:56*SAMPLE_RATE,end:116*SAMPLE_RATE},{start:112*SAMPLE_RATE,end:120*SAMPLE_RATE}]);
});
it("reconstructs recording across storage boundaries without dropped or inserted samples",async()=>{
  const segments:LocalSegment[]=Array.from({length:31},(_,i)=>({id:`m-${i+1}`,meetingId:"m",sequence:i+1,createdAt:1,durationMs:2000,blob:wav(Int16Array.from({length:48000},(_,j)=>(i*48000+j)%20000))}));
  const windows=[];for await(const window of audioWindows(segments))windows.push(window);
  expect(windows).toHaveLength(2);expect(windows[1].startMs).toBe(56000);
  const first=await readWav(windows[0].blob),last=await readWav(windows[1].blob);
  expect([...first.slice(-96000)]).toEqual([...last.slice(0,96000)]);
  expect(first.length+last.length-96000).toBe(31*48000);
});
it("refuses gaps instead of generating an apparently complete transcript",async()=>{
  const broken:LocalSegment[]=[{id:"m-2",meetingId:"m",sequence:2,createdAt:1,durationMs:1,blob:wav(new Int16Array(24))}];
  await expect(audioWindows(broken).next()).rejects.toThrow("ontbreekt");
});
it("can decode older self-contained audio backups",async()=>{
  const close=vi.fn(async()=>undefined);
  vi.stubGlobal("AudioContext",class{decodeAudioData=vi.fn(async()=>({sampleRate:24000,length:24,numberOfChannels:1,getChannelData:()=>new Float32Array(24).fill(.5)}));close=close;});
  const legacy:LocalSegment={id:"m-1",meetingId:"m",sequence:1,createdAt:1,durationMs:1,blob:new Blob(["legacy"],{type:"audio/webm"})};
  const result=[];for await(const window of audioWindows([legacy]))result.push(window);
  expect((await readWav(result[0].blob))[0]).toBe(16384);expect(close).toHaveBeenCalledOnce();
});
