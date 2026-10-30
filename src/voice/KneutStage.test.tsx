// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KneutStage, stagePresentation } from "./KneutStage";
import type { VoiceSnapshot } from "./voiceSession";
const idle: VoiceSnapshot = {status:"idle",micMuted:false,playbackBlocked:false};
const activity={lastFrameAt:10000,lastSpeechAt:10000,level:.7};
beforeEach(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(){this.setAttribute("open","");}});
 Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(){this.removeAttribute("open");}});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
it("only shows live listening for current audio with live text available",()=>{
 expect(stagePresentation(idle,true,true,false,activity,10001)).toMatchObject({mode:"listening",level:.7});
 expect(stagePresentation(idle,true,true,false,activity,12000)).toMatchObject({mode:"waiting",level:0});
 expect(stagePresentation(idle,true,false,false,activity,10001).mode).toBe("waiting");
 expect(stagePresentation(idle,false,true,false,activity,10001).mode).toBe("paused");
});
it("distinguishes actual dialogue, mute, preparation and blocked playback",()=>{
 const voice={...idle,status:"listening" as const};
 expect(stagePresentation({...voice,userSpeaking:true},false,false,false,undefined,1)).toMatchObject({mode:"listening",level:.6});
 expect(stagePresentation({...voice,micMuted:true},true,true,false,activity,10001)).toMatchObject({mode:"muted",level:0});
 expect(stagePresentation(idle,true,true,true,activity,10001).mode).toBe("thinking");
 expect(stagePresentation({...voice,status:"speaking",playbackBlocked:true},true,true,false,activity,10001).mode).toBe("waiting");
});
function props(){return {snapshot:idle,recording:true,liveAvailable:true,preparing:false,getActivity:()=>({...activity,lastFrameAt:Date.now()}),recordingLabel:"Opname loopt · 00:10:00",onClose:vi.fn(),onTalk:vi.fn(),onEndTalk:vi.fn(),onCancelPreparation:vi.fn(),onMute:vi.fn(),onInterrupt:vi.fn(),onPlay:vi.fn()};}
it("opens a modal without starting a conversation, follows audio and routes close independently",()=>{
 vi.useFakeTimers();const callbacks=props();render(<KneutStage {...callbacks} alerts={<p role="alert">Opslag bijna vol</p>} recordingActions={<button>Pauzeer</button>}/>);
 expect(screen.getByRole("dialog",{name:"Kneut"})).toBeTruthy();expect(screen.getByText("Ik luister mee")).toBeTruthy();
 expect(screen.getByRole("alert").textContent).toBe("Opslag bijna vol");expect(screen.getByRole("button",{name:"Pauzeer"})).toBeTruthy();
 expect(callbacks.onTalk).not.toHaveBeenCalled();expect(document.body.style.overflow).toBe("hidden");
 act(()=>{vi.advanceTimersByTime(100);});expect(document.querySelector("[data-hearing='true']")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Terug naar vergadering"}));expect(callbacks.onClose).toHaveBeenCalledOnce();expect(callbacks.onEndTalk).not.toHaveBeenCalled();
 cleanup();expect(document.body.style.overflow).toBe("");
});
it("keeps the stage usable when browser fullscreen is unavailable",async()=>{
 render(<KneutStage {...props()}/>);fireEvent.click(screen.getByRole("button",{name:"Volledig scherm"}));
 expect(await screen.findByText(/adresbalk zichtbaar/)).toBeTruthy();expect(screen.getByRole("dialog",{name:"Kneut"})).toBeTruthy();
});
it("cancel closes the stage without ending the dialogue",()=>{
 const callbacks=props();render(<KneutStage {...callbacks} snapshot={{...idle,status:"listening"}}/>);
 fireEvent(screen.getByRole("dialog"),new Event("cancel",{cancelable:true}));expect(callbacks.onClose).toHaveBeenCalledOnce();expect(callbacks.onEndTalk).not.toHaveBeenCalled();
});
