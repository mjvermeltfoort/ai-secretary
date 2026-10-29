// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
const rig=vi.hoisted(()=>({recorder:null as any,recOptions:null as any,liveOptions:null as any,live:null as any,review:vi.fn(),notes:vi.fn(),voiceProps:null as any,checkpoint:undefined as any, segments:[] as any[],mic:{clone:true},reviewOrder:[] as string[]}));
vi.mock("./lib/firebase",()=>({auth:{currentUser:{email:"mjvermeltfoort@gmail.com",emailVerified:true,providerData:[{providerId:"google.com"}]}}}));
vi.mock("firebase/auth",()=>({onAuthStateChanged:(_a:any,cb:any)=>{cb({email:"mjvermeltfoort@gmail.com",emailVerified:true,providerData:[{providerId:"google.com"}]});return()=>{};},GoogleAuthProvider:class{},signOut:vi.fn(),signInWithPopup:vi.fn()}));
vi.mock("./recording/localSegmentStore",()=>({IndexedDbSegmentStore:class{list=async()=>rig.segments;put=vi.fn();loadMeeting=async()=>rig.checkpoint;saveMeeting=async(_id:string,patch:any)=>{rig.checkpoint={...rig.checkpoint,...patch};};meetings=async()=>rig.segments.length?[{id:rig.segments[0].meetingId,startedAt:1,count:1}]:[];}}));
vi.mock("./recording/browserRecorder",()=>({BrowserRecorder:class{
 recordingState={status:"ready",nextSequence:1,uploadedSequences:[],localSequences:[] as number[]};
 constructor(options:any){rig.recorder=this;rig.recOptions=options;}
 start=async(id:string)=>{this.recordingState.status="recording";rig.segments=[{meetingId:id,sequence:1,id:"s1",durationMs:2000,createdAt:1,blob:new Blob(["test"])}];this.recordingState.localSequences=[1];};
 cloneMicrophone=()=>rig.mic;
 pause=async()=>{this.recordingState.status="paused";};stop=async()=>{this.recordingState.status="stopped";};
}}));
vi.mock("./transcription/liveTranscription",()=>({LiveTranscription:class{constructor(_m:string,result:any,state:any){rig.liveOptions={result,state};rig.live=this;}start=vi.fn(async()=>rig.liveOptions.state("live"));close=vi.fn();finish=async()=>{};reconnect=vi.fn();noteSpeech=vi.fn();notifySavedAudio=vi.fn();}}));
vi.mock("./transcription/review",()=>({reviewRecording:rig.review}));
vi.mock("./notes/notesClient",()=>({createMeetingNotes:rig.notes}));
vi.mock("./voice/VoicePanel",()=>({VoicePanel:(props:any)=>{rig.voiceProps=props;return <div data-testid="voice">Overleg met notulist</div>;}}));
import { App } from "./App";
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();rig.segments=[];rig.checkpoint=undefined;rig.reviewOrder=[];rig.review.mockImplementation(async(id:string)=>{rig.reviewOrder.push("review");return[{meetingId:id,sequence:1,text:"Gecontroleerde tekst",model:"test"}];});rig.notes.mockImplementation(async(id:string)=>{rig.reviewOrder.push("notes");return{meetingId:id,revision:"r",summary:"Notulen",decisions:[],actionItems:[],clarificationQuestions:[],model:"test"};});});
afterEach(cleanup);
it("shares one meeting and microphone with the notulist and reviews audio before notes",async()=>{
 render(<App/>);await waitFor(()=>expect((screen.getByRole("button",{name:"Start vergadering"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Start vergadering"}));
 await screen.findByRole("button",{name:"Rond vergadering af"});
 const meetingId=rig.voiceProps.meetingId;expect(rig.voiceProps.getMicrophone()).toBe(rig.mic);
 act(()=>rig.liveOptions.result({meetingId,sequence:1000000,text:"Live woorden",model:"test",provisional:true}));
 await waitFor(()=>expect(rig.voiceProps.transcripts[0].text).toBe("Live woorden"));
 expect(rig.recorder.recordingState.status).toBe("recording");
 fireEvent.click(screen.getByRole("button",{name:"Rond vergadering af"}));
 await screen.findByText("Gecontroleerde tekst");
 fireEvent.click(screen.getByRole("button",{name:"Maak definitieve notulen"}));
 await screen.findByRole("heading",{name:"Notulen"});expect(rig.reviewOrder).toEqual(["review","notes"]);
 expect(rig.voiceProps.stopSignal).toBe(1);
});
it("keeps local recordings accessible when the final online review fails",async()=>{
 rig.review.mockRejectedValueOnce(new Error("Geen internet"));render(<App/>);
 await waitFor(()=>expect((screen.getByRole("button",{name:"Start vergadering"}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole("button",{name:"Start vergadering"}));
 fireEvent.click(await screen.findByRole("button",{name:"Rond vergadering af"}));
 await screen.findByText("Geen internet");expect(rig.segments).toHaveLength(1);
 expect(rig.recorder.recordingState.status).toBe("stopped");
 expect(screen.getByRole("button",{name:"Transcript opnieuw controleren"})).toBeTruthy();
});

it("restores the latest text and notes and allows continuing the same recorded meeting",async()=>{
 const id="meeting-restored";localStorage.setItem("secretary-active-meeting",JSON.stringify({id,startedAt:1}));
 rig.segments=[{meetingId:id,sequence:1,id:"s1",durationMs:2000,createdAt:1,blob:new Blob(["test"])}];
 rig.checkpoint={id,reviewedAudioCount:1,transcripts:[{meetingId:id,sequence:1,text:"Bewaarde volledige tekst",model:"test"}],notes:{meetingId:id,revision:"r1",summary:"Bewaarde notulen",decisions:[],actionItems:[],clarificationQuestions:[],model:"test"}};
 render(<App/>);await screen.findByText("Bewaarde volledige tekst");await screen.findByText("Bewaarde notulen");
 expect(screen.getByRole("button",{name:"Download opname"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Hervat vergadering"}));
 await screen.findByRole("button",{name:"Rond vergadering af"});expect(rig.voiceProps.meetingId).toBe(id);
});
it("blocks recording until a low-storage warning is explicitly acknowledged",async()=>{
 Object.defineProperty(navigator,"storage",{configurable:true,value:{estimate:async()=>({quota:1_000_000,usage:0})}});
 try {
  render(<App/>);await waitFor(()=>expect((screen.getByRole("button",{name:"Start vergadering"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Start vergadering"}));
  const override=await screen.findByRole("button",{name:"Toch starten met beperkte opslag"});expect(rig.recorder.recordingState.status).toBe("ready");
  fireEvent.click(override);await screen.findByRole("button",{name:"Rond vergadering af"});
 } finally {Object.defineProperty(navigator,"storage",{configurable:true,value:undefined});}
});

it("still updates recording controls if final flushing reports an error",async()=>{
 render(<App/>);await waitFor(()=>expect((screen.getByRole("button",{name:"Start vergadering"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Start vergadering"}));await screen.findByRole("button",{name:"Rond vergadering af"});
 rig.recorder.stop=async()=>{rig.recorder.recordingState.status="stopped";throw new Error("Laatste audio niet bevestigd");};
 fireEvent.click(screen.getByRole("button",{name:"Rond vergadering af"}));await screen.findByText("Laatste audio niet bevestigd");
 expect(screen.getByRole("button",{name:"Hervat vergadering"})).toBeTruthy();expect(screen.getByRole("button",{name:"Download opname"})).toBeTruthy();
});

it("pauses live transcription during consultation and resumes only while recording",async()=>{
 render(<App/>);await waitFor(()=>expect((screen.getByRole("button",{name:"Start vergadering"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Start vergadering"}));await screen.findByRole("button",{name:"Rond vergadering af"});
 const count=rig.live.start.mock.calls.length;
 act(()=>rig.voiceProps.onConsultationChange(true));
 expect(rig.live.close).toHaveBeenCalled();expect(rig.recorder.recordingState.status).toBe("recording");
 expect(screen.getByText("Live tekst gepauzeerd · overleg met Kneut")).toBeTruthy();
 act(()=>window.dispatchEvent(new Event("online")));expect(rig.live.reconnect).not.toHaveBeenCalled();
 act(()=>rig.voiceProps.onConsultationChange(false));expect(rig.live.start).toHaveBeenCalledTimes(count+1);
 act(()=>rig.voiceProps.onConsultationChange(true));
 fireEvent.click(screen.getByRole("button",{name:"Rond vergadering af"}));
 act(()=>rig.voiceProps.onConsultationChange(false));await screen.findByText("Gecontroleerde tekst");
 expect(rig.live.start).toHaveBeenCalledTimes(count+1);
});
