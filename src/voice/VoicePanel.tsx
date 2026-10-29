import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MeetingNotes, ActionItemProposal } from "../notes/notesClient";
import { saveActionItemProposal } from "../notes/notesClient";
import type { TranscriptResult } from "../transcription/transcriptionClient";
import { KneutController, type KneutState } from "./kneutController";
import { assessClarity } from "./kneutClient";
import { createVoiceToken } from "./voiceClient";
import { meetingVoiceContext } from "./voiceContext";
import { VoiceSession, type VoiceMessage, type VoiceSnapshot } from "./voiceSession";

interface Props {
  meetingId: string;
  transcripts: TranscriptResult[];
  notes?: MeetingNotes;
  onNotesUpdated: (notes: MeetingNotes) => void;
  getMicrophone?: () => MediaStream | undefined;
  stopSignal?: number;
  recording?: boolean;
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
const labels = { idle: "Luistert stil mee via het transcript", connecting: "Verbinding maken…", listening: "Luistert naar je vraag", thinking: "Denkt na…", speaking: "Spreekt", error: "Gesprek niet verbonden" };

export function VoicePanel(props: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<VoiceSession | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
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
      getContext: () => meetingVoiceContext(props.meetingId, latest.current.transcripts, latest.current.notes),
      onSnapshot: (value) => { if (alive.current) setSnapshot(value); },
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
      alive.current = false;
      voice.disconnect();
      session.current = null;
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
          turns: turns.map(t => ({ id: t.sequence, text: t.text })),
          incomplete: !!current.getSpeechActivity?.().transcriptPending || current.transcripts.some(t => t.provisional && !t.liveFinal),
          recording: !!current.recording, live: !!current.liveAvailable,
          ...(current.getSpeechActivity?.() ?? { lastSpeechAt: Date.now(), lastFrameAt: 0 }),
          voiceBusy: ["thinking", "speaking"].includes(voice.status),
          manualDialogue: !voice.controlled && !["idle", "error"].includes(voice.status),
        };
      },
      assess: text => assessClarity(props.meetingId, text),
      speak: (text, allowed) => session.current?.speakControlled(text, allowed) ?? Promise.resolve(false),
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

  return <section className={`voice-panel voice-${snapshot.status}`} aria-labelledby="voice-heading">
    <div className="voice-intro">
      <div className="notulist-character" role="img" aria-label={`AI-notulist: ${labels[snapshot.status]}`}>
        <div className="character-halo" /><div className="character-face"><i className="character-eye" /><i className="character-eye" /><span className="character-mouth" /></div>
      </div>
      <div className="voice-title"><span className="label">Jouw AI-notulist</span><h2 id="voice-heading">Kneut, je notulist</h2>
        <p className="voice-status" role="status">{kneut.listening ? "Kneut luistert naar je vraag…" : snapshot.controlled && snapshot.status === "listening" ? "Kneut luistert stil mee via de vergadertekst" : snapshot.micMuted && snapshot.status === "listening" ? "Microfoon uit · je kunt ook typen" : labels[snapshot.status]}</p>
        <p className="voice-explainer">{props.recording
          ? "Zeg ‘Kneut’ en stel je vraag. Ik bewaar onduidelijkheden en vraag alleen bij een duidelijke overgang om uitleg."
          : "Start een gesprek om me iets te vragen. Open vragen blijven hieronder zichtbaar."}</p>
      </div>
    </div>
    <div className="voice-controls">
      {!active || snapshot.controlled ? <button className="record-button" onClick={() => void session.current?.start()}>Praat met de notulist</button>
        : <button className="secondary-button" onClick={() => session.current?.disconnect()}>{connected ? "Terug naar meeluisteren" : "Annuleren"}</button>}
      {connected && !snapshot.controlled && <>
        <button className="voice-outline-button" aria-pressed={snapshot.micMuted} onClick={() => session.current?.setMicMuted(!snapshot.micMuted)}>{snapshot.micMuted ? "Microfoon aan" : "Microfoon uit"}</button>
        {(snapshot.status === "speaking" || snapshot.status === "thinking") && <button className="voice-outline-button" onClick={() => session.current?.interrupt()}>Onderbreek antwoord</button>}
      </>}
    </div>
    <div className="kneut-questions">
      <div className="voice-controls">
        <button className="voice-outline-button" aria-pressed={kneut.deferred} onClick={() => controller.current?.defer(!kneut.deferred)}>{kneut.deferred ? "Vragen bij overgangen weer toestaan" : "Bewaar vragen tot het einde"}</button>
        {snapshot.controlled && <button className="voice-outline-button" onClick={() => session.current?.disconnect()}>Gesprek stoppen</button>}
      </div>
      {props.recording && !props.liveAvailable && <p role="status">Aanspreken met ‘Kneut’ wacht op de live transcriptie.</p>}
      {kneut.deferred && <p role="status">Kneut bewaart zijn vragen tot het einde. Je kunt hem blijven aanspreken.</p>}
      {kneut.questions.length > 0 && <>{!props.recording && <button className="voice-outline-button" onClick={() => void session.current?.speakControlled(`Lees deze open vragen kort voor: ${JSON.stringify(kneut.questions)}`, () => !latest.current.recording)}>Bespreek open vragen na afloop</button>}<h3>Open vragen{props.recording ? "" : " bij afronden"}</h3><ul>{kneut.questions.map(q => <li key={q.id}>{q.question}</li>)}</ul></>}
      {kneut.error && <p role="status">{kneut.error}</p>}
    </div>
    <p className="voice-footnote">Opname, transcriptie en dit overleg horen bij dezelfde vergadering. Gebruik oortjes om de AI-stem uit je opname te houden. Live transcriptie, beoordeling van open vragen en overleg gebruiken je OpenAI-budget. Alleen het overleg stopt na vijf minuten; transcriptie loopt mee met de opname.</p>
    {snapshot.error && <p className="voice-error" role="alert">{snapshot.error}</p>}
    {snapshot.playbackBlocked && <button className="voice-outline-button" onClick={() => void session.current?.playAudio()}>Gesproken antwoord afspelen</button>}
    <audio ref={audio} autoPlay controls={connected} className="voice-audio" aria-label="Stem van de AI-notulist" />
    {(connected || messages.length > 0) && <div className="voice-conversation">
      <div className="voice-chat-heading"><h3>Overleg binnen deze vergadering</h3><span>AI-antwoorden zijn geen vergaderbesluiten</span></div>
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
  </section>;
}
