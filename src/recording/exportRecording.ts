import type { LocalSegment } from "./localSegmentStore";
import { SAMPLE_RATE } from "./pcm";
interface AudioSink { write(data:Blob|Uint8Array):Promise<void>; close():Promise<void>; abort():Promise<void>; }
interface FilePicker { showSaveFilePicker(options:unknown):Promise<{createWritable():Promise<AudioSink>}>; }

export async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer())),n=>n.toString(16).padStart(2,"0")).join("");
}
export async function verifySegment(segment:LocalSegment) {
  const bytes=await segment.blob.slice(0,44).arrayBuffer();const view=new DataView(bytes);
  if(bytes.byteLength!==44 || view.getUint32(0)!==0x52494646 || view.getUint32(8)!==0x57415645
    || view.getUint16(20,true)!==1 || view.getUint16(22,true)!==1 || view.getUint32(24,true)!==SAMPLE_RATE
    || view.getUint16(34,true)!==16 || view.getUint32(36)!==0x64617461 || view.getUint32(40,true)!==segment.blob.size-44
    || (segment.blob.size-44)%2!==0 || Math.abs((segment.blob.size-44)/48-segment.durationMs)>1) throw new Error("Een audioblok is beschadigd of gebruikt een ouder formaat. De originele bestanden blijven bewaard.");
  if(segment.checksum && await sha256(segment.blob)!==segment.checksum) throw new Error("De controlecode van een audioblok klopt niet. De originele bestanden blijven bewaard.");
}
export function wavHeader(dataBytes:number):Uint8Array {
  if(!Number.isSafeInteger(dataBytes) || dataBytes<=0 || dataBytes>0xffffffff-36) throw new Error("Deze opname past niet in één WAV-bestand.");
  const header=new Uint8Array(44),v=new DataView(header.buffer);
  const text=(offset:number,value:string)=>[...value].forEach((c,i)=>v.setUint8(offset+i,c.charCodeAt(0)));
  text(0,"RIFF");v.setUint32(4,dataBytes+36,true);text(8,"WAVE");text(12,"fmt ");v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,SAMPLE_RATE,true);v.setUint32(28,SAMPLE_RATE*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,"data");v.setUint32(40,dataBytes,true);return header;
}
export async function writeRecording(segments:LocalSegment[], sink?:AudioSink):Promise<Blob|undefined> {
  const sorted=[...segments].sort((a,b)=>a.sequence-b.sequence);
  if(!sorted.length || sorted.some((s,i)=>s.sequence!==i+1 || s.meetingId!==sorted[0].meetingId))throw new Error("Audio ontbreekt; export zou onvolledig zijn.");
  const header=wavHeader(sorted.reduce((n,s)=>n+s.blob.size-44,0));
  const pieces:BlobPart[]=sink?[]:[header];
  try {
    if(sink)await sink.write(header);
    for(const segment of sorted) {
      await verifySegment(segment);
      const audio=segment.blob.slice(44);
      if(sink)await sink.write(audio);else pieces.push(audio);
    }
    if(sink)await sink.close();else return new Blob(pieces,{type:"audio/wav"});
  } catch(cause) {await sink?.abort().catch(()=>undefined);throw cause;}
}
export function downloadBlob(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export async function exportRecording(meetingId:string, getSegments:()=>Promise<LocalSegment[]>):Promise<boolean> {
  const picker=(window as unknown as Partial<FilePicker>).showSaveFilePicker;
  let sink:AudioSink|undefined;
  try {
    if(picker) {
      // Request the destination while the user's click still supplies user activation.
      const handle=await picker.call(window,{suggestedName:`${meetingId}.wav`,types:[{description:"Vergaderopname",accept:{"audio/wav":[".wav"]}}]});
      sink=await handle.createWritable();
    }
    const blob=await writeRecording(await getSegments(),sink);
    if(blob)downloadBlob(blob,`${meetingId}.wav`);
    return true;
  } catch(cause) {
    await sink?.abort().catch(()=>undefined);
    if(cause instanceof DOMException && cause.name==="AbortError")return false;
    throw cause;
  }
}
