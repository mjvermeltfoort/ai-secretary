import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { buildRecoveryPlan, type RecordingState } from "./domain/recording";
import { BrowserRecorder } from "./recording/browserRecorder";
import { auth } from "./lib/firebase";
import { canUseApp } from "./lib/access";
import { transcribeLocalSegment, type TranscriptResult } from "./transcription/transcriptionClient";
import { IndexedDbSegmentStore } from "./recording/localSegmentStore";
import { TranscriptQueue, type QueueSnapshot } from "./transcription/transcriptQueue";
import { createMeetingNotes, type MeetingNotes } from "./notes/notesClient";

const initialState: RecordingState = {
  status: "ready",
  nextSequence: 1,
  uploadedSequences: [],
  localSequences: [],
};
const emptyQueueSnapshot: QueueSnapshot = { pending: 0, processing: 0, completed: 0, failed: 0 };

function createSessionId(): string {
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `meeting-${Date.now()}-${suffix}`;
}

export function App() {
  const [session, setSession] = useState(() => ({ id: createSessionId(), startedAt: Date.now() }));
  const recorder = useRef<BrowserRecorder | null>(null);
  const queue = useRef<TranscriptQueue | null>(null);
  const [recording, setRecording] = useState<RecordingState>(initialState);
  const [error, setError] = useState<string>();
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [transcripts, setTranscripts] = useState<TranscriptResult[]>([]);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>(emptyQueueSnapshot);
  const [notes, setNotes] = useState<MeetingNotes>();
  const [notesLoading, setNotesLoading] = useState(false);
  const meetingId = session.id;
  const sessionIdRef = useRef(meetingId);
  sessionIdRef.current = meetingId;
  const recovery = useMemo(() => buildRecoveryPlan(recording), [recording]);

  useEffect(() => onAuthStateChanged(auth, (currentUser) => {
    setUser(currentUser);
    if (!canUseApp(currentUser)) {
      setTranscripts([]);
      setNotes(undefined);
      setQueueSnapshot(emptyQueueSnapshot);
      void recorder.current?.stop().then(() => {
        setRecording(recorder.current?.recordingState ?? initialState);
      });
    }
  }), []);

  useEffect(() => {
    if (canUseApp(user)) void queue.current?.process(meetingId);

    const retryWhenOnline = () => {
      if (canUseApp(auth.currentUser)) void queue.current?.process(meetingId);
    };
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [meetingId, user]);

  useEffect(() => {
    const store = new IndexedDbSegmentStore();
    queue.current = new TranscriptQueue({
      store,
      transcribe: transcribeLocalSegment,
      onSnapshot: (snapshot, snapshotMeetingId) => {
        if (sessionIdRef.current === snapshotMeetingId) setQueueSnapshot(snapshot);
      },
      onResult: (result) => {
        if (sessionIdRef.current !== result.meetingId) return;
        setTranscripts((current) => [...current.filter((item) => item.sequence !== result.sequence), result]
          .sort((a, b) => a.sequence - b.sequence));
      },
    });
    recorder.current = new BrowserRecorder({
      onSegment: (segment) => {
        setRecording(recorder.current?.recordingState ?? initialState);
        if (canUseApp(auth.currentUser)) void queue.current?.process(segment.meetingId);
      },
      onError: (cause) => setError(cause.message),
      store,
    });
    if (canUseApp(auth.currentUser)) void queue.current.process(meetingId);

    return () => {
      void recorder.current?.stop();
    };
  }, []);

  async function startOrResume() {
    setError(undefined);

    try {
      if (!canUseApp(auth.currentUser)) throw new Error("Dit account heeft geen toegang tot deze app.");
      await recorder.current?.start(meetingId);
      setRecording(recorder.current?.recordingState ?? initialState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Opname kon niet starten.");
    }
  }

  async function signIn() {
    setError(undefined);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google-login mislukt.");
    }
  }

  function pause() {
    recorder.current?.pause();
    setRecording(recorder.current?.recordingState ?? initialState);
  }

  async function stop() {
    await recorder.current?.stop();
    setRecording(recorder.current?.recordingState ?? initialState);
  }

  function retryTranscriptie() {
    setError(undefined);
    if (canUseApp(auth.currentUser)) void queue.current?.process(meetingId);
  }

  function startNewSession() {
    if (isRecording || isPaused) return;
    setSession({ id: createSessionId(), startedAt: Date.now() });
    setRecording(initialState);
    setTranscripts([]);
    setNotes(undefined);
    setQueueSnapshot(emptyQueueSnapshot);
    setError(undefined);
  }

  async function generateNotes() {
    setError(undefined);
    setNotesLoading(true);
    try {
      if (!canUseApp(auth.currentUser)) throw new Error("Dit account heeft geen toegang tot deze app.");
      setNotes(await createMeetingNotes(meetingId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notulen maken mislukt.");
    } finally {
      setNotesLoading(false);
    }
  }

  async function signOutAccount() {
    setError(undefined);
    try {
      await recorder.current?.stop();
      await signOut(auth);
      setRecording(initialState);
      setTranscripts([]);
      setNotes(undefined);
      setQueueSnapshot(emptyQueueSnapshot);
      setSession({ id: createSessionId(), startedAt: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Uitloggen mislukt.");
    }
  }

  const isRecording = recording.status === "recording";
  const isPaused = recording.status === "paused";

  if (!canUseApp(user)) {
    return <main className="shell"><section className="hero">
      <p className="eyebrow">AI Vergadersecretaris</p>
      <h1>{user ? "Geen toegang" : "Log in om te beginnen"}</h1>
      <p role={user ? "alert" : undefined}>{user
        ? "Dit Google-account heeft geen toegang tot deze privé-app."
        : "Deze app is alleen toegankelijk voor het toegestane Google-account."}</p>
      {user
        ? <button className="secondary-button" onClick={() => void signOutAccount()}>Uitloggen en ander account kiezen</button>
        : <button className="secondary-button" onClick={() => void signIn()}>Log in met Google</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section></main>;
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">AI Vergadersecretaris</p>
        <h1>Vergaderingen die niets vergeten.</h1>
        <p className="intro">
          Lokale opname eerst. Transcriptie, vragen en actiepunten daarna.
        </p>
        <div className="account-row">
          {user ? <span>Ingelogd als {user.email ?? user.displayName ?? "Google-gebruiker"}</span> : <span>Log in voor OpenAI-transcriptie.</span>}
          {user && <button className="secondary-button" onClick={() => void signOutAccount()}>Uitloggen</button>}
          {!user && <button className="secondary-button" onClick={() => void signIn()}>Log in met Google</button>}
        </div>
        <div className="session-row">
          <span>Sessie gestart {new Date(session.startedAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}</span>
          <button className="secondary-button" onClick={startNewSession} disabled={isRecording || isPaused || notesLoading}>
            Nieuwe sessie
          </button>
        </div>
        <div className="record-actions">
          {!isRecording && (
            <button className="record-button" onClick={() => void startOrResume()} disabled={!canUseApp(user)}>
              {isPaused ? "Hervat opname" : "Start opname"}
            </button>
          )}
          {isRecording && <button className="secondary-button" onClick={pause}>Pauzeer</button>}
          {(isRecording || isPaused) && <button className="secondary-button" onClick={() => void stop()}>Stop</button>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="transcript-card">
        <div className="transcript-heading">
          <div><span className="label">Transcriptie</span><h2>Live tekst</h2></div>
          <div className="queue-actions">
            <span>{transcripts.length} segmenten</span>
            {queueSnapshot.failed > 0 && <button className="retry-button" onClick={retryTranscriptie}>Retry {queueSnapshot.failed}</button>}
            {transcripts.length > 0 && <button
              className="secondary-light-button"
              onClick={() => void generateNotes()}
              disabled={notesLoading || queueSnapshot.pending > 0 || queueSnapshot.processing > 0 || queueSnapshot.failed > 0}
            >
              {notesLoading ? "Notulen maken…" : "Genereer notulen"}
            </button>}
          </div>
        </div>
        {transcripts.length === 0 ? <p className="muted">Start een opname na Google-login. Elk lokaal segment wordt daarna server-side getranscribeerd.</p> : transcripts.map((transcript) => (
          <p className="transcript-line" key={transcript.sequence}><span>#{transcript.sequence}</span>{transcript.text}</p>
        ))}
      </section>

      {notes && <section className="notes-card">
        <div className="transcript-heading">
          <div><span className="label">AI-uitwerking</span><h2>Notulen</h2></div>
          <span className="muted">{notes.actionItems.length} actiepunten</span>
        </div>
        <p className="notes-summary">{notes.summary}</p>
        {notes.decisions.length > 0 && <div className="notes-block">
          <h3>Besluiten</h3>
          <ul>{notes.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
        </div>}
        {notes.actionItems.length > 0 && <div className="notes-block">
          <h3>Actiepunten</h3>
          <ul className="action-list">{notes.actionItems.map((item) => <li key={`${item.description}-${item.owner ?? "unknown"}`}>
            <strong>{item.description}</strong>
            <span>{item.owner ?? "Eigenaar ontbreekt"} · {item.deadline ?? "Deadline ontbreekt"}</span>
          </li>)}</ul>
        </div>}
        {notes.clarificationQuestions.length > 0 && <div className="clarification-block">
          <h3>Verduidelijking nodig</h3>
          <ul>{notes.clarificationQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
        </div>}
      </section>}

      <section className="status-card" aria-live="polite">
        <div>
          <span className="label">Status</span>
          <strong>{isRecording ? "Opname loopt" : isPaused ? "Gepauzeerd" : "Gereed"}</strong>
        </div>
        <div>
          <span className="label">Lokale segmenten</span>
          <strong>{recording.localSequences.length}</strong>
        </div>
        <div>
          <span className="label">Herstelqueue</span>
          <strong>{recovery.missingSequences.length} segmenten</strong>
        </div>
      </section>

      <section className="feature-grid">
        <article><span>01</span><h2>Offline veilig</h2><p>Audiosegmenten gaan direct naar lokale IndexedDB-opslag.</p></article>
        <article><span>02</span><h2>Live scherp</h2><p>OpenAI verwerkt transcriptie server-side, zonder sleutel in de app.</p></article>
        <article><span>03</span><h2>Actiegericht</h2><p>Eigenaar en deadline worden gecontroleerd voordat een actiepunt klaar is.</p></article>
      </section>
    </main>
  );
}
