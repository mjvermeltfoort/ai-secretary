import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { KneutCharacter, type KneutMode } from "./KneutCharacter";
import type { VoiceSnapshot } from "./voiceSession";

export interface SpeechActivity { lastSpeechAt: number; lastFrameAt: number; level?: number; transcriptPending?: boolean; }
interface Props {
  snapshot: VoiceSnapshot;
  recording: boolean;
  liveAvailable: boolean;
  preparing: boolean;
  getActivity?: () => SpeechActivity;
  recordingLabel: string;
  recordingActions?: ReactNode;
  alerts?: ReactNode;
  proposalPending?: boolean;
  onClose: () => void;
  onTalk: () => void;
  onEndTalk: () => void;
  onCancelPreparation: () => void;
  onMute: () => void;
  onInterrupt: () => void;
  onPlay: () => void;
}
export function stagePresentation(snapshot: VoiceSnapshot, recording: boolean, live: boolean, preparing: boolean, activity: SpeechActivity | undefined, now: number): {mode: KneutMode; label: string; hint: string; level: number} {
  const fresh = !!activity && now - activity.lastFrameAt < 1500;
  const level = fresh ? Math.max(0, Math.min(1, activity?.level ?? 0)) : 0;
  const active = !["idle", "error"].includes(snapshot.status);
  if (snapshot.playbackBlocked) return {mode:"waiting", label:"Tik om mijn antwoord te horen", hint:"Je browser wacht op toestemming om geluid af te spelen.", level:0};
  if (preparing) return {mode:"thinking", label:"Ik lees de vergadering bij", hint:"Even de samenvatting voorbereiden…", level:0};
  if (snapshot.status === "speaking") return {mode:"speaking", label:"Kneut spreekt", hint:"Je kunt mijn antwoord onderbreken.", level:0};
  if (snapshot.status === "thinking" || snapshot.status === "connecting") return {mode:"thinking", label:snapshot.status === "thinking" ? "Ik denk even na" : "Verbinding maken", hint:"Een ogenblik…", level:0};
  if (active && !snapshot.controlled) {
    if (snapshot.micMuted) return {mode:"muted", label:"Gespreksmicrofoon uit", hint:recording ? "De vergaderopname loopt door." : "Zet de microfoon aan om verder te praten.", level:0};
    return {mode:"listening", label:"Ik luister naar je vraag", hint:"Je praat nu met Kneut.", level:snapshot.userSpeaking ? Math.max(level,.6) : level};
  }
  if (recording) {
    if (!fresh) return {mode:"waiting", label:"Wachten op microfoongeluid", hint:"Controleer de opname als dit blijft staan.", level:0};
    if (!live) return {mode:"waiting", label:"Opname loopt · live tekst niet beschikbaar", hint:"Spraakactivering wacht tot de live tekst is bijgewerkt.", level};
    return {mode:"listening", label:"Ik luister mee", hint:"Zeg ‘Kneut’ en stel je vraag.", level};
  }
  if (snapshot.status === "error") return {mode:"error", label:"Gesprek niet verbonden", hint:"Je kunt het gesprek opnieuw starten.", level:0};
  return {mode:"paused", label:"Klaar voor je vraag", hint:"Start of hervat de opname om mee te luisteren.", level:0};
}

export function KneutStage(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(props); latest.current = props;
  const [activity, setActivity] = useState<SpeechActivity>();
  const [now, setNow] = useState(Date.now());
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [fullscreenNotice, setFullscreenNotice] = useState<string>();
  const ownsFullscreen = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const node = dialog.current!, previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    const update = () => { setActivity(latest.current.getActivity?.()); setNow(Date.now()); };
    update(); const timer = setInterval(update,100);
    const changed = () => {setFullscreen(!!document.fullscreenElement);if(!document.fullscreenElement)ownsFullscreen.current=false;};
    document.addEventListener("fullscreenchange",changed);
    return () => {
      mounted.current = false;
      clearInterval(timer); document.removeEventListener("fullscreenchange",changed);
      document.body.style.overflow = previousOverflow;
      node.close(); previousFocus?.focus();
      if(ownsFullscreen.current && document.fullscreenElement===document.documentElement)void document.exitFullscreen().catch(()=>undefined);
    };
  }, []);
  async function toggleFullscreen() {
    setFullscreenNotice(undefined);
    try {
      if(document.fullscreenElement)await document.exitFullscreen();
      else {
        if(!document.documentElement.requestFullscreen)throw new Error("unavailable");
        await document.documentElement.requestFullscreen();
        if(!mounted.current){if(document.fullscreenElement)await document.exitFullscreen();return;}
        ownsFullscreen.current=true;setFullscreen(true);
      }
    } catch { if(mounted.current)setFullscreenNotice("Je browser houdt de adresbalk zichtbaar. Kneut vult het appvenster."); }
  }
  const state=stagePresentation(props.snapshot,props.recording,props.liveAvailable,props.preparing,activity,now);
  const active=!["idle","error"].includes(props.snapshot.status) && !props.snapshot.controlled;
  return <dialog ref={dialog} className="kneut-stage" aria-labelledby="kneut-stage-title" onCancel={event=>{event.preventDefault();props.onClose();}}>
    <div className="kneut-stage-inner" data-mode={state.mode} data-hearing={state.level>.08} style={{"--voice-level":state.level} as CSSProperties}>
      <header className="stage-header"><div><h2 id="kneut-stage-title">Kneut</h2><span className="stage-recording-label">{props.recordingLabel}</span></div><div className="stage-header-actions"><button className="stage-icon-button" onClick={()=>void toggleFullscreen()} aria-label={fullscreen?"Verlaat volledig scherm":"Volledig scherm"} title={fullscreen?"Verlaat volledig scherm":"Volledig scherm"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button><button className="stage-icon-button" onClick={props.onClose} aria-label="Terug naar vergadering" title="Terug naar vergadering" autoFocus>×</button></div></header>
      <div className="stage-alerts">{props.alerts}{props.snapshot.error && <p role="alert">{props.snapshot.error}</p>}{props.proposalPending && <button className="stage-text-button" onClick={props.onClose}>Controleer wijzigingsvoorstel in de vergadering</button>}{fullscreenNotice && <p role="status">{fullscreenNotice}</p>}</div>
      <main className="stage-scene">
        <div className="stage-aura" aria-hidden="true"><i/><i/><i/></div>
        <KneutCharacter mode={state.mode} large />
      </main>
      <footer className="stage-footer">
        <div className="stage-activity" aria-hidden="true">{[.4,.7,1,.65,.95,.55,.8].map((weight,i)=><i key={i} style={{"--bar-weight":weight} as CSSProperties}/>)}</div>
        <p className="stage-status" role="status">{state.label}</p><p className="stage-hint">{state.hint}</p>
        <div className="stage-conversation-actions">
          {props.preparing ? <button onClick={props.onCancelPreparation}>Voorbereiden annuleren</button> : active ? <><button className="stage-primary-button" onClick={props.onEndTalk}>Terug naar meeluisteren</button><button onClick={props.onMute}>{props.snapshot.micMuted ? "Microfoon aan" : "Microfoon uit"}</button></> : <button className="stage-primary-button" onClick={props.onTalk}>Praat met Kneut</button>}
          {["thinking","speaking"].includes(props.snapshot.status) && !props.preparing && <button onClick={props.onInterrupt}>Onderbreken</button>}
          {props.snapshot.playbackBlocked && <button onClick={props.onPlay}>Antwoord afspelen</button>}
        </div>
        {props.recordingActions && <div className="stage-recording-actions" aria-label="Opnamebediening">{props.recordingActions}</div>}
      </footer>
    </div>
  </dialog>;
}
