// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { checkStorage, FOUR_HOURS_MS, RecordingWakeLock } from "./recordingSupport";
afterEach(()=>vi.unstubAllGlobals());
it("requires four hours plus storage headroom and degrades if quota inspection is unavailable",async()=>{
 vi.stubGlobal("navigator",{storage:{persist:async()=>true,estimate:async()=>({quota:2_000_000_000,usage:100_000_000})}});
 expect(await checkStorage(FOUR_HOURS_MS,true)).toMatchObject({status:"ok",requiredBytes:849440000,persistent:true});
 vi.stubGlobal("navigator",{storage:{estimate:async()=>({quota:1_000_000,usage:0})}});expect((await checkStorage()).status).toBe("low");
 vi.stubGlobal("navigator",{});expect((await checkStorage()).status).toBe("unknown");
});
it("releases the wake lock on pause and cleans up a late permission result",async()=>{
 let resolve!:(handle:any)=>void;
 const handle={release:vi.fn(async()=>{}),addEventListener:vi.fn()};const onStatus=vi.fn();
 vi.stubGlobal("navigator",{wakeLock:{request:vi.fn(()=>new Promise(r=>{resolve=r;}))}});
 const guard=new RecordingWakeLock(onStatus);guard.setActive(true);guard.setActive(false);resolve(handle);
 await Promise.resolve();await Promise.resolve();expect(handle.release).toHaveBeenCalledOnce();expect(onStatus).not.toHaveBeenCalledWith(true);guard.dispose();
});
it("reacquires a wake lock when returning to a visible document",async()=>{
 let release!:()=>void;const request=vi.fn(async()=>({release:async()=>{},addEventListener:(_t:string,listener:()=>void)=>{release=listener;}}));
 vi.stubGlobal("navigator",{wakeLock:{request}});const guard=new RecordingWakeLock(vi.fn());guard.setActive(true);await Promise.resolve();
 release();document.dispatchEvent(new Event("visibilitychange"));await Promise.resolve();expect(request).toHaveBeenCalledTimes(2);guard.dispose();
});
