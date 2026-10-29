import { useEffect, useRef, useState, type FormEvent, type ReactNode, type KeyboardEvent } from "react";
import type { MeetingNotes, ActionItemProposal } from "../notes/notesClient";
import { saveActionItemProposal } from "../notes/notesClient";
import type { TranscriptResult } from "../transcription/transcriptionClient";
import { KneutController, type KneutState } from "./kneutController";
import { assessClarity } from "./kneutClient";
import { createVoiceToken } from "./voiceClient";
import { prepareVoiceBriefing } from "./voiceBriefing";
import { briefingSource, meetingVoiceContext, type VoiceBriefing } from "./voiceContext";
import { VoiceSession, type VoiceMessage, type VoiceSnapshot } from "./voiceSession";

interface Props {
  liveContent?: ReactNode;
  notesContent?: ReactNode;
  meetingId: string;
  transcripts: TranscriptResult[];
  notes?: MeetingNotes;
  onNotesUpdated: (notes: MeetingNotes) => void;
  getMicrophone?: () => MediaStream | undefined;
  stopSignal?: number;
  recording?: boolean;
  initialBriefing?: VoiceBriefing;
  onBriefingUpdated?: (briefing: VoiceBriefing) => void;
  onConsultationChange?: (active: boolean) => void;
  liveAvailable?: boolean;
  getSpeechActivity?: () => { lastSpeechAt: number; lastFrameAt: number; transcriptPending?: boolean };
}
interface PendingProposal { proposal: ActionItemProposal; expectedRevision: string; }
function savedKneut(meetingId: string): KneutState {
  try {
    const saved = JSON.parse(localStorage.getItem(`kneut-${meetingId}`) ?? "null");
    if (saved && typeof saved.deferred === "boolean" && Array.isArray(saved.questions) && saved.questions.length <= 8
      && saved.questions.every((q: any) => typeof q.id === "string" && typeof q.question === "string" && typeof q.evidence === "string")) {
      return { questions: saved.questions, deferred: saved.deferred, listening: false,
        askedIds: Array.isArray(saved.askedIds) ? saved.askedIds.filter((id: unknown) => typeof id === "string").slice(-1000) : [],
        lastIntervention: typeof saved.lastIntervention === "number" ? saved.lastIntervention : undefined };
    }
  } catch { /* Local state is optional; recording works without browser storage. */ }
  return { questions: [], deferred: false, listening: false };
}
const initial: VoiceSnapshot = { status: "idle", micMuted: false, playbackBlocked: false };
const labels = { idle: "Luistert mee", connecting: "Verbinden…", listening: "Luistert naar je vraag", thinking: "Denkt na…", speaking: "Spreekt", error: "Niet verbonden" };

export function VoicePanel(props: Props) {
  const [tab, setTab] = useState("summary");
  const [historyOpen, setHistoryOpen] = useState(false);
  const tabs = [{id:"summary",label:"Samenvatting"},{id:"live",label:"Live tekst"},{id:"notes",label:"Notulen"}];
  const tabPrefix = `meeting-${props.meetingId}`;
  function changeTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : event.key === "ArrowRight" ? (index+1)%3 : event.key === "ArrowLeft" ? (index+2)%3 : undefined;
    if (next === undefined) return;
    event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${tabPrefix}-tab-${tabs[next].id}`)?.focus();
  }
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<VoiceSession | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  const briefing = useRef<VoiceBriefing | undefined>(props.initialBriefing);
  const [generalSummary, setGeneralSummary] = useState<VoiceBriefing | undefined>(props.initialBriefing);
  const [summaryWorking, setSummaryWorking] = useState(false);
  const summaryEpoch = useRef(0);
  const summaryTask = useRef<{sourceText:string;explicit:boolean;promise:Promise<VoiceBriefing>} | undefined>(undefined);
  const preparationEpoch = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const [briefingProgress, setBriefingProgress] = useState({done:0,total:0});
  const [briefingError, setBriefingError] = useState<string>();
  const consultationActive = useRef(false);
  const pendingRef = useRef<PendingProposal | undefined>(undefined);
  const [snapshot, setSnapshot] = useState(initial);
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<PendingProposal>();
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const controller = useRef<KneutController | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [kneut, setKneut] = useState<KneutState>(() => savedKneut(props.meetingId));
  const chatLog = useRef<HTMLDivElement>(null);
  const active = !["idle", "error"].includes(snapshot.status);
  const connected = active && snapshot.status !== "connecting";
  const stale = !!pending && pending.expectedRevision !== props.notes?.revision;

  useEffect(() => {
    alive.current = true;
    const voice = new VoiceSession({
      audio: audio.current!,
      createToken: () => createVoiceToken(props.meetingId),
      getMicrophone: () => latest.current.getMicrophone?.(),
      getContext: () => meetingVoiceContext(props.meetingId, latest.current.transcripts, latest.current.notes, briefing.current),
      onSnapshot: (value) => {
        if (!alive.current) return;
        setSnapshot(value);
        if (["idle", "error"].includes(value.status) && consultationActive.current) {
          consultationActive.current = false;++preparationEpoch.current;setPreparing(false);
          if(summaryTask.current && !summaryTask.current.explicit){++summaryEpoch.current;setSummaryWorking(false);}
          latest.current.onConsultationChange?.(false);
        }
      },
      onMessage: (message) => {
        if (!alive.current) return;
        setMessages((current) => {
          const exists = current.some((item) => item.id === message.id);
          return (exists ? current.map((item) => item.id === message.id ? message : item) : [...current, message]).slice(-50);
        });
      },
      onProposal: ({ notesRevision, ...proposal }) => {
        const notes = latest.current.notes;
        if (!notes?.revision || !notes.actionItems[proposal.itemIndex]) return "Genereer eerst notulen met dit actiepunt. Er is niets gewijzigd.";
        if (notes.revision !== notesRevision) return "De notulen zijn gewijzigd sinds je context. Gebruik de nieuwste context en vraag opnieuw.";
        if (pendingRef.current) return "Er wacht al een voorstel op bevestiging. Vraag de gebruiker dat eerst te bevestigen of af te wijzen.";
        const next = { proposal, expectedRevision: notesRevision };
        pendingRef.current = next;
        setPending(next);
        setEditError(undefined);
        setNotice(undefined);
        return "Voorstel staat in de app. Er is nog niets opgeslagen. Vraag de gebruiker het te controleren en op Wijziging opslaan te klikken.";
      },
    });
    session.current = voice;
    return () => {
      alive.current = false;++preparationEpoch.current;++summaryEpoch.current;
      voice.disconnect();
      session.current = null;
      if (consultationActive.current && !latest.current.recording) latest.current.onConsultationChange?.(false);
      consultationActive.current = false;
    };
  }, [props.meetingId]);

  useEffect(() => {
    const monitor = new KneutController({
      initial: savedKneut(props.meetingId),
      getInput: () => {
        const current = latest.current;
        const voice = snapshotRef.current;
        const turns = current.transcripts.filter(t => t.provisional && t.liveFinal);
        return {
          text: turns.map(t => t.text).join("\n").slice(-28000),
          turns: turns.filter(t=>!t.replayed).map(t => ({ id: t.sequence, text: t.text })),
          incomplete: !!turns.at(-1)?.replayed || !!current.getSpeechActivity?.().transcriptPending || current.transcripts.some(t => t.provisional && !t.liveFinal),
          recording: !!current.recording, live: !!current.liveAvailable,
          ...(current.getSpeechActivity?.() ?? { lastSpeechAt: Date.now(), lastFrameAt: 0 }),
          voiceBusy: ["thinking", "speaking"].includes(voice.status),
          manualDialogue: !voice.controlled && !["idle", "error"].includes(voice.status),
        };
      },
      ask: (text, displayText) => beginDialogue(text, displayText),
      assess: text => assessClarity(props.meetingId, text),
      speak: (text, allowed, displayText) => session.current?.speakControlled(text, allowed, displayText) ?? Promise.resolve(false),
      interrupt: () => session.current?.interrupt(),
      onChange: state => {
        setKneut(state);
        try { localStorage.setItem(`kneut-${props.meetingId}`, JSON.stringify({ ...state, listening: false, error: undefined })); } catch { /* Audio saving remains independent. */ }
      },
    });
    controller.current = monitor;
    const timer = setInterval(() => monitor.tick(), 250);
    return () => { clearInterval(timer); monitor.dispose(); controller.current = null; };
  }, [props.meetingId]);

  useEffect(() => { if(props.stopSignal)session.current?.disconnect(); }, [props.stopSignal]);
  useEffect(() => { session.current?.updateContext(); }, [props.transcripts, props.notes]);
  useEffect(() => {
    const node = chatLog.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(()=>{
    if(props.initialBriefing){briefing.current=props.initialBriefing;setGeneralSummary(props.initialBriefing);}
  },[props.initialBriefing]);

  async function ensureSummary(explicit:boolean, consumerAllowed:()=>boolean=()=>alive.current):Promise<VoiceBriefing> {
    if(!consumerAllowed())throw new Error("Voorbereiden is afgebroken.");
    const id=latest.current.meetingId,sourceText=briefingSource(id,latest.current.transcripts);
    if(briefing.current?.sourceText===sourceText)return briefing.current;
    if(summaryTask.current){
      if(explicit)summaryTask.current.explicit=true;
      const existing=summaryTask.current;
      try{const result=await existing.promise;if(!consumerAllowed())throw new Error("Voorbereiden is afgebroken.");if(result.sourceText===sourceText)return result;}catch(cause){if(!consumerAllowed()||existing.sourceText===sourceText)throw cause;}
    }
    if(!consumerAllowed())throw new Error("Voorbereiden is afgebroken.");
    const epoch=++summaryEpoch.current;
    const allowed=()=>alive.current && epoch===summaryEpoch.current && latest.current.meetingId===id;
    setSummaryWorking(true);setBriefingProgress({done:0,total:0});setBriefingError(undefined);
    const promise=prepareVoiceBriefing(id,latest.current.transcripts,allowed,(done,total)=>{if(allowed())setBriefingProgress({done,total});})
      .then(result=>{
        if(!allowed())throw new Error("Voorbereiden is afgebroken.");
        briefing.current=result;setGeneralSummary(result);latest.current.onBriefingUpdated?.(result);return result;
      }).finally(()=>{if(allowed())setSummaryWorking(false);if(summaryTask.current?.promise===promise)summaryTask.current=undefined;});
    summaryTask.current={sourceText,explicit,promise};
    return promise;
  }
  async function updateGeneralSummary() {
    try{await ensureSummary(true);}catch(cause){if(alive.current)setBriefingError(cause instanceof Error?cause.message:"Samenvatten is mislukt. Probeer het opnieuw.");}
  }

  function cancelPreparation() {
    ++preparationEpoch.current;setPreparing(false);setBriefingError(undefined);
    if(summaryTask.current && !summaryTask.current.explicit){++summaryEpoch.current;setSummaryWorking(false);}
    consultationActive.current=false;session.current?.disconnect();latest.current.onConsultationChange?.(false);
  }

  async function beginDialogue(text?: string, displayText?: string): Promise<boolean> {
    if (consultationActive.current) {
      if (preparing) return false;
      return await session.current?.startDialogue(text, displayText) ?? false;
    }
    const epoch=++preparationEpoch.current,id=latest.current.meetingId;
    const allowed=()=>alive.current && epoch===preparationEpoch.current && latest.current.meetingId===id && consultationActive.current;
    consultationActive.current=true;latest.current.onConsultationChange?.(true);session.current?.interrupt();
    setPreparing(true);setBriefingError(undefined);setBriefingProgress({done:0,total:0});
    try {
      const summary=await ensureSummary(false,allowed);
      if(!allowed())return false;
      if(summary.sourceText!==briefingSource(id,latest.current.transcripts))throw new Error("De vergadertekst is intussen bijgewerkt. Start het gesprek opnieuw voor een actuele samenvatting.");
      briefing.current=summary;setPreparing(false);
      const started=await session.current?.startDialogue(text,displayText)??false;
      if(!started && consultationActive.current) {consultationActive.current=false;latest.current.onConsultationChange?.(false);}
      return started;
    } catch(cause) {
      if(allowed()) {
        setBriefingError(cause instanceof Error?cause.message:"De samenvatting kon niet worden voorbereid. Probeer het gesprek opnieuw te starten.");
        consultationActive.current=false;latest.current.onConsultationChange?.(false);
      }
      return false;
    } finally {if(epoch===preparationEpoch.current)setPreparing(false);}
  }

  function sendQuestion(event: FormEvent) {
    event.preventDefault();
    session.current?.sendText(question);
    setQuestion("");
  }

  async function confirmProposal() {
    if (!pending || saving || stale) return;
    setSaving(true);
    setEditError(undefined);
    try {
      const notes = await saveActionItemProposal(props.meetingId, pending.expectedRevision, pending.proposal);
      if (!alive.current) return;
      latest.current.onNotesUpdated(notes);
      pendingRef.current = undefined;
      setPending(undefined);
      setNotice("Actiepunt opgeslagen in de notulen.");
      session.current?.notifyDecision("De gebruiker heeft de voorgestelde wijziging bevestigd. Het actiepunt is opgeslagen. De notulencontext wordt bijgewerkt.");
    } catch (cause) {
      if (alive.current) setEditError(cause instanceof Error ? cause.message : "Opslaan mislukt. Er is niets gewijzigd.");
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  function rejectProposal() {
    pendingRef.current = undefined;
    setPending(undefined);
    setEditError(undefined);
    session.current?.notifyDecision("De gebruiker heeft het voorstel afgewezen. Er is niets gewijzigd.");
  }

  return <section className={`voice-panel voice-state-${snapshot.status}`} aria-labelledby="voice-heading">
    <div className="voice-intro">
      <div className="notulist-character" role="img" aria-label={`AI-notulist: ${labels[snapshot.status]}`}>
        <div className="character-halo" /><div className="character-face"><i className="character-eye" /><i className="character-eye" /><span className="character-mouth" /></div>
      </div>
      <div className="voice-title"><h2 id="voice-heading">Kneut</h2>
        <p className="voice-status" role="status">{preparing ? "Leest de vergadering bij…" : kneut.listening ? "Luistert naar je vraag…" : snapshot.controlled && snapshot.status === "listening" ? "Luistert mee" : snapshot.micMuted && snapshot.status === "listening" ? "Microfoon uit · je kunt ook typen" : snapshot.status === "idle" && !props.recording ? "Klaar voor je vraag" : labels[snapshot.status]}</p>
        {!active && !preparing && props.recording && <p className="voice-explainer">Zeg ‘Kneut’ om een vraag te stellen.</p>}
      </div>
    </div>
    <div className="voice-controls">
      {preparing ? <button className="secondary-button" onClick={cancelPreparation}>Voorbereiden annuleren</button> : !active || snapshot.controlled ? <button className="record-button" onClick={() => void beginDialogue()}>Praat met Kneut</button>
        : <button className="secondary-button" onClick={() => session.current?.disconnect()}>{connected ? "Terug naar meeluisteren" : "Annuleren"}</button>}
      {connected && !snapshot.controlled && <>
        <button className="voice-outline-button" aria-pressed={snapshot.micMuted} onClick={() => session.current?.setMicMuted(!snapshot.micMuted)}>{snapshot.micMuted ? "Microfoon aan" : "Microfoon uit"}</button>
        {(snapshot.status === "speaking" || snapshot.status === "thinking") && <button className="voice-outline-button" onClick={() => session.current?.interrupt()}>Onderbreek antwoord</button>}
      </>}
    </div>
    {summaryWorking && briefingProgress.total>0 && <p role="status">Samenvatting voorbereiden: {briefingProgress.done} van {briefingProgress.total} tekstdelen.</p>}
    {briefingError && <p className="voice-error" role="alert">{briefingError}</p>}
    <div className="kneut-settings"><label htmlFor="kneut-timing">Vragen stellen</label><select id="kneut-timing" value={kneut.deferred?"end":"transitions"} onChange={event=>controller.current?.defer(event.target.value==="end")}><option value="transitions">Bij overgangen</option><option value="end">Na afloop</option></select></div>
    {props.recording && !props.liveAvailable && !active && !preparing && <p className="muted" role="status">Spraakactivering wacht op live tekst.</p>}
    {kneut.error && <p role="status">{kneut.error}</p>}

    {snapshot.error && <div className="voice-error" role="alert"><p>{snapshot.error}</p>{snapshot.diagnostic && <details><summary>Technische foutgegevens</summary><p>Code: {snapshot.diagnostic.code}{snapshot.diagnostic.parameter && <> · Veld: {snapshot.diagnostic.parameter}</>}{snapshot.diagnostic.event && <> · Verzoek: {snapshot.diagnostic.event}</>}</p></details>}</div>}
    {snapshot.playbackBlocked && <button className="voice-outline-button" onClick={() => void session.current?.playAudio()}>Gesproken antwoord afspelen</button>}
    <audio ref={audio} autoPlay controls={connected} className="voice-audio" aria-label="Stem van de AI-notulist" />
    {!active && messages.length>0 && <button className="history-toggle" aria-expanded={historyOpen} aria-controls={`${tabPrefix}-history`} onClick={()=>setHistoryOpen(!historyOpen)}>{historyOpen ? "Verberg gesprek" : "Bekijk laatste gesprek"}</button>}
    {(connected || messages.length > 0) && <div id={`${tabPrefix}-history`} className="voice-conversation" hidden={!active && !historyOpen}>
      <div className="voice-chat-heading"><h3>Overleg met Kneut</h3></div>
      <div ref={chatLog} className="voice-chat-log" role="log" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && <p className="muted">Stel je vraag hardop of typ hem hieronder.</p>}
        {messages.map((message) => <div className={`voice-message voice-message-${message.role}`} key={message.id}>
          <strong>{message.role === "user" ? "Jij" : "AI-notulist"}</strong><p>{message.text}{!message.final && <span aria-hidden="true"> ▍</span>}</p>
          {message.interrupted && <small>Antwoord onderbroken</small>}
        </div>)}
      </div>
      {connected && <form className="voice-question" onSubmit={sendQuestion}>
        <label className="sr-only" htmlFor="voice-question">Vraag aan de notulist</label>
        <input id="voice-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} placeholder="Wat hebben we tot nu toe besloten?" autoComplete="off" />
        <button className="secondary-light-button" type="submit" disabled={!question.trim()}>Verstuur</button>
      </form>}
    </div>}
    {pending && <div className="voice-proposal" aria-labelledby="proposal-heading">
      <span className="label">Controleer het voorstel</span><h3 id="proposal-heading">Actiepunt {pending.proposal.itemIndex + 1} wijzigen</h3>
      <p>{pending.proposal.description}</p><dl><div><dt>Eigenaar</dt><dd>{pending.proposal.owner || "Onbekend"}</dd></div><div><dt>Deadline</dt><dd>{pending.proposal.deadline || "Onbekend"}</dd></div></dl>
      {stale && <p role="alert">De notulen zijn intussen gewijzigd. Wijs dit voorstel af en vraag een nieuw voorstel.</p>}
      {editError && <p className="voice-error" role="alert">{editError}</p>}
      <div className="voice-controls"><button className="secondary-light-button" disabled={saving || stale} onClick={() => void confirmProposal()}>{saving ? "Opslaan…" : "Wijziging opslaan"}</button><button className="voice-outline-button" disabled={saving} onClick={rejectProposal}>Afwijzen</button></div>
    </div>}
    {notice && <p className="voice-notice" role="status">{notice}</p>}

    <div className="meeting-tabs" role="tablist" aria-label="Vergaderinhoud">{tabs.map((item,index)=><button key={item.id} id={`${tabPrefix}-tab-${item.id}`} type="button" role="tab" aria-selected={tab===item.id} aria-controls={`${tabPrefix}-panel-${item.id}`} tabIndex={tab===item.id?0:-1} onClick={()=>setTab(item.id)} onKeyDown={event=>changeTab(event,index)}>{item.label}</button>)}</div>
    <div className="meeting-tabpanel" role="tabpanel" id={`${tabPrefix}-panel-summary`} aria-labelledby={`${tabPrefix}-tab-summary`} hidden={tab!=="summary"} tabIndex={0}>    <section className="meeting-summary" aria-label="Algemene samenvatting">
      <h2>Wat is er besproken?</h2>
      <button className="voice-outline-button" disabled={summaryWorking || !briefingSource(props.meetingId,props.transcripts)} onClick={()=>void updateGeneralSummary()}>{summaryWorking?"Samenvatting voorbereiden…":generalSummary?"Bijwerken":"Maak samenvatting"}</button>
      {generalSummary ? <>
        {generalSummary.sourceText!==briefingSource(props.meetingId,props.transcripts) && <p className="muted">Nieuwe tekst beschikbaar · werk de samenvatting bij.</p>}
        <p className="summary-text">{generalSummary.summary}</p>
        {generalSummary.provisional && <p className="muted">Voorlopig · gebaseerd op live tekst.</p>}
      </> : <p className="muted">Maak een samenvatting van de besproken onderwerpen en afspraken.</p>}
    </section>
<div className="kneut-questions">
      {kneut.questions.length > 0 && <><h3>Open vragen <span className="question-count">{kneut.questions.length}</span></h3><ul>{kneut.questions.map(q=><li key={q.id}>{q.question}</li>)}</ul>{!props.recording && <button className="voice-outline-button" onClick={()=>void beginDialogue(`Lees deze open vragen kort voor: ${JSON.stringify(kneut.questions)}`,"Welke vragen staan er nog open?")}>Bespreek open vragen</button>}</>}
    </div></div>
    <div className="meeting-tabpanel" role="tabpanel" id={`${tabPrefix}-panel-live`} aria-labelledby={`${tabPrefix}-tab-live`} hidden={tab!=="live"} tabIndex={0}>{props.liveContent ?? <p className="muted">Nog geen vergadertekst.</p>}</div>
    <div className="meeting-tabpanel" role="tabpanel" id={`${tabPrefix}-panel-notes`} aria-labelledby={`${tabPrefix}-tab-notes`} hidden={tab!=="notes"} tabIndex={0}>{props.notesContent ?? <p className="muted">Nog geen notulen.</p>}</div>
  </section>;
}
