export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
export const BYTES_PER_MS = 48;
export interface StorageCheck { status: "ok" | "low" | "unknown"; availableBytes?: number; requiredBytes: number; persistent?: boolean; }
export async function checkStorage(remainingMs = FOUR_HOURS_MS, requestPersistence = false): Promise<StorageCheck> {
  const requiredBytes = Math.ceil(Math.max(0, remainingMs) * BYTES_PER_MS * 1.2 + 20_000_000);
  try {
    let persistent: boolean | undefined;
    if(requestPersistence && navigator.storage?.persist) persistent = await navigator.storage.persist().catch(()=>false);
    const {quota,usage} = await navigator.storage?.estimate?.() ?? {};
    if(typeof quota !== "number" || typeof usage !== "number") return {status:"unknown",requiredBytes,persistent};
    const availableBytes = Math.max(0,quota-usage);
    return {status:availableBytes<requiredBytes?"low":"ok",requiredBytes,availableBytes,persistent};
  } catch {return {status:"unknown",requiredBytes};}
}
interface WakeHandle { release(): Promise<void>; addEventListener(type:string,listener:()=>void):void; }
export class RecordingWakeLock {
  private wanted = false;
  private epoch = 0;
  private handle?: WakeHandle;
  private requesting = false;
  private readonly visibility = () => { if(document.visibilityState === "visible") void this.acquire(); };
  constructor(private readonly onStatus:(active:boolean)=>void) { document.addEventListener("visibilitychange",this.visibility); }
  setActive(active:boolean) {
    this.wanted=active;++this.epoch;
    if(active)void this.acquire();
    else {const old=this.handle;this.handle=undefined;void old?.release().catch(()=>undefined);this.onStatus(false);}
  }
  private async acquire() {
    if(!this.wanted || this.handle || this.requesting || document.visibilityState === "hidden")return;
    const wake = (navigator as Navigator & {wakeLock?:{request(type:"screen"):Promise<WakeHandle>}}).wakeLock;
    if(!wake) {this.onStatus(false);return;}
    this.requesting=true;const epoch=this.epoch;
    try {
      const handle = await wake.request("screen");
      if(epoch!==this.epoch || !this.wanted) {await handle.release();return;}
      this.handle=handle;this.onStatus(true);
      handle.addEventListener("release",()=>{if(this.handle===handle){this.handle=undefined;this.onStatus(false);}});
    } catch {this.onStatus(false);}
    finally {this.requesting=false;if(this.wanted && epoch!==this.epoch)void this.acquire();}
  }
  dispose() {this.setActive(false);document.removeEventListener("visibilitychange",this.visibility);}
}
