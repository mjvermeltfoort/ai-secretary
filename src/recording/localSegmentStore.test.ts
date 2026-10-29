import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexedDbSegmentStore, type LocalSegment } from "./localSegmentStore";
import { wav } from "./pcm";
beforeEach(()=>vi.stubGlobal("indexedDB",new IDBFactory()));
afterEach(()=>vi.unstubAllGlobals());
const segment:LocalSegment={id:"m-1",meetingId:"m",sequence:1,createdAt:1,durationMs:1000,blob:wav(new Int16Array(24000))};
it("upgrades a v1 database without losing existing recordings",async()=>{
 await new Promise<void>((resolve,reject)=>{
  const request=indexedDB.open("ai-vergadersecretaris",1);
  request.onupgradeneeded=()=>{const table=request.result.createObjectStore("recording-segments",{keyPath:"id"});table.createIndex("meetingId","meetingId");table.add(segment);};
  request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);
 });
 const store=new IndexedDbSegmentStore();expect(await store.list("m")).toHaveLength(1);
 await store.saveMeeting("m",{live:{version:1,cursor:0,nextSequence:1000000,turns:[]}});
 expect((await store.loadMeeting("m"))?.live?.cursor).toBe(0);expect((await store.list("m"))[0].blob.size).toBe(segment.blob.size);
});
it("merges independently saved notes and live progress without overwriting either",async()=>{
 const store=new IndexedDbSegmentStore();
 await Promise.all([store.saveMeeting("m",{live:{version:1,cursor:24,nextSequence:1000000,turns:[]}}),store.saveMeeting("m",{reviewedAudioCount:1,transcripts:[]})]);
 expect(await store.loadMeeting("m")).toMatchObject({live:{cursor:24},reviewedAudioCount:1,transcripts:[]});
});
it("never overwrites an existing audio segment on recorder append",async()=>{
 const store=new IndexedDbSegmentStore();await store.append(segment);
 await expect(store.append({...segment,blob:wav(new Int16Array(24000).fill(10))})).rejects.toBeDefined();
 expect((await store.list("m"))[0].blob.size).toBe(segment.blob.size);expect((await store.meetings())[0]).toMatchObject({id:"m",count:1});
});
