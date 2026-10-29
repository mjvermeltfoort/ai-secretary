import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import type { TranscriptResult } from "../transcription/transcriptionClient";
import { briefingSource, type VoiceBriefing } from "./voiceContext";
const summarize=httpsCallable<{meetingId:string;runId:string;sequence:number;total:number;text:string},{summary:string}>(functions,"summarizeVoiceContext",{timeout:130000});
export function briefingChunks(text:string):string[] {
  const chunks:string[]=[];let rest=text;
  while(rest.length){
    let end=Math.min(24000,rest.length);
    if(end<rest.length){const boundary=rest.lastIndexOf(" ",end);if(boundary>12000)end=boundary;}
    chunks.push(rest.slice(0,end));rest=rest.slice(end).trimStart();
  }
  if(chunks.length>40)throw new Error("De beschikbare tekst is te lang voor één gesprekssamenvatting.");
  return chunks;
}
export async function prepareVoiceBriefing(meetingId:string,transcripts:TranscriptResult[],allowed:()=>boolean,progress:(done:number,total:number)=>void):Promise<VoiceBriefing> {
  const sourceText=briefingSource(meetingId,transcripts),chunks=briefingChunks(sourceText);
  if(!chunks.length)return {summary:"Er is nog geen afgeronde vergadertekst beschikbaar. Zeg dat als er naar afspraken wordt gevraagd.",sourceText,provisional:true};
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(sourceText))),n=>n.toString(16).padStart(2,"0")).join("");
  let summary="";progress(0,chunks.length);
  for(const [index,text] of chunks.entries()){
    if(!allowed())throw new Error("Voorbereiden van het gesprek is afgebroken.");
    const result=await summarize({meetingId,runId:`brief-${hash}`,sequence:index+1,total:chunks.length,text});
    if(!allowed())throw new Error("Voorbereiden van het gesprek is afgebroken.");
    if(typeof result.data.summary!=="string" || !result.data.summary.trim() || result.data.summary.length>8000)throw new Error("Geen bruikbare gesprekssamenvatting ontvangen.");
    summary=result.data.summary.trim();progress(index+1,chunks.length);
  }
  return {summary,sourceText,provisional:transcripts.some(t=>t.meetingId===meetingId&&t.provisional)};
}
