import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MeetingNotes, ActionItemProposal } from "../notes/notesClient";
import { saveActionItemProposal } from "../notes/notesClient";
import type { TranscriptResult } from "../transcription/transcriptionClient";
import { createVoiceToken } from "./voiceClient";
import { meetingVoiceContext } from "./voiceContext";
import { VoiceSession, type VoiceMessage, type VoiceSnapshot } from "./voiceSession";

interface Props {
  meetingId: string;
  transcripts: TranscriptResult[];
  notes?: MeetingNotes;
  onNotesUpdated: (notes: MeetingNotes) => void;
}
interface PendingProposal { proposal: ActionItemProposal; expectedRevision: string; }
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
  const chatLog = useRef<HTMLDivElement>(null);
  const active = !["idle", "error"].includes(snapshot.status);
  const connected = active && snapshot.status !== "connecting";
  const stale = !!pending && pending.expectedRevision !== props.notes?.revision;

  useEffect(() => {
    alive.current = true;
    const voice = new VoiceSession({
      audio: audio.current!,
      createToken: () => createVoiceToken(props.meetingId),
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
      <div className="voice-title"><span className="label">Jouw AI-notulist</span><h2 id="voice-heading">Even overleggen?</h2>
        <p className="voice-status" role="status">{snapshot.micMuted && snapshot.status === "listening" ? "Microfoon uit · je kunt ook typen" : labels[snapshot.status]}</p>
        <p className="voice-explainer">{active
          ? "Je praat nu met de notulist. Onderbreek gerust. Stop het gesprek als de vergadering verdergaat."
          : "Ik gebruik de beschikbare vergadertekst als context. Start een gesprek om me iets te vragen."}</p>
      </div>
    </div>
    <div className="voice-controls">
      {!active ? <button className="record-button" onClick={() => void session.current?.start()}>Praat met de notulist</button>
        : <button className="secondary-button" onClick={() => session.current?.disconnect()}>{connected ? "Terug naar meeluisteren" : "Annuleren"}</button>}
      {connected && <>
        <button className="voice-outline-button" aria-pressed={snapshot.micMuted} onClick={() => session.current?.setMicMuted(!snapshot.micMuted)}>{snapshot.micMuted ? "Microfoon aan" : "Microfoon uit"}</button>
        {(snapshot.status === "speaking" || snapshot.status === "thinking") && <button className="voice-outline-button" onClick={() => session.current?.interrupt()}>Onderbreek antwoord</button>}
      </>}
    </div>
    <p className="voice-footnote">Gesprek en vergaderopname staan los van elkaar. Gebruik oortjes om de AI-stem uit je opname te houden. Live spraak gebruikt je OpenAI-budget en stopt na vijf minuten.</p>
    {snapshot.error && <p className="voice-error" role="alert">{snapshot.error}</p>}
    {snapshot.playbackBlocked && <button className="voice-outline-button" onClick={() => void session.current?.playAudio()}>Gesproken antwoord afspelen</button>}
    <audio ref={audio} autoPlay controls={connected} className="voice-audio" aria-label="Stem van de AI-notulist" />
    {(connected || messages.length > 0) && <div className="voice-conversation">
      <div className="voice-chat-heading"><h3>Gesprek met de notulist</h3><span>Los van het vergadertranscript</span></div>
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
