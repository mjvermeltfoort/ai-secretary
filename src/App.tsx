import { useEffect, useRef, useState } from "react";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { type RecordingState } from "./domain/recording";
import { checkStorage, FOUR_HOURS_MS, RecordingWakeLock, type StorageCheck } from "./recording/recordingSupport";
import { downloadBlob, exportRecording } from "./recording/exportRecording";
import { BrowserRecorder } from "./recording/browserRecorder";
import { auth } from "./lib/firebase";
import { canUseApp } from "./lib/access";
import { type TranscriptResult } from "./transcription/transcriptionClient";
import { IndexedDbSegmentStore } from "./recording/localSegmentStore";
import { LiveTranscription, type LiveState } from "./transcription/liveTranscription";
import { reviewRecording } from "./transcription/review";
import { createMeetingNotes, type MeetingNotes } from "./notes/notesClient";
import type { VoiceBriefing } from "./voice/voiceContext";
import { VoicePanel } from "./voice/VoicePanel";

const initialState: RecordingState = {
  status: "ready",
  nextSequence: 1,
  uploadedSequences: [],
  localSequences: [],
};


function createSessionId(): string {
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `meeting-${Date.now()}-${suffix}`;
}

export function App() {
  const [session, setSession] = useState(() => {
    try { const old = JSON.parse(localStorage.getItem("secretary-active-meeting") ?? "null"); if (old && /^meeting-[a-zA-Z0-9_-]+$/.test(old.id) && typeof old.startedAt === "number") return old as { id: string; startedAt: number }; } catch {}
    return { id: createSessionId(), startedAt: Date.now() };
  });
  const recorder = useRef<BrowserRecorder | null>(null);
  const store = useRef(new IndexedDbSegmentStore());
  const live = useRef<LiveTranscription | null>(null);
  const speech = useRef({ lastSpeechAt: Date.now(), lastFrameAt: 0 });
  const reviewPromise = useRef<Promise<TranscriptResult[]> | null>(null);
  const [consulting, setConsulting] = useState(false);
  const consultingRef = useRef(false);
  const endingMeeting = useRef(false);
  const [restoring, setRestoring] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [storageCheck, setStorageCheck] = useState<StorageCheck>();
  const [limitedStorage, setLimitedStorage] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);
  const [backupNotice, setBackupNotice] = useState<string>();
  const wake = useRef<RecordingWakeLock | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("idle");
  const [reviewed, setReviewed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [transitioning, setTransitioning] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);
  const [savedMeetings, setSavedMeetings] = useState<Array<{id:string;startedAt:number;count:number}>>([]);
  const [recording, setRecording] = useState<RecordingState>(initialState);
  const [error, setError] = useState<string>();
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [transcripts, setTranscripts] = useState<TranscriptResult[]>([]);

  const [briefingSnapshot, setBriefingSnapshot] = useState<VoiceBriefing>();
  const [notes, setNotes] = useState<MeetingNotes>();
  const [notesLoading, setNotesLoading] = useState(false);
  const meetingId = session.id;
  const sessionIdRef = useRef(meetingId);
  sessionIdRef.current = meetingId;
  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    try { localStorage.setItem("secretary-active-meeting", JSON.stringify(session)); } catch {}
    const allowed = () => !cancelled && sessionIdRef.current === meetingId && canUseApp(auth.currentUser);
    const transcriber = new LiveTranscription(meetingId, (result) => {
      if (!allowed()) return;
      setTranscripts(current => [...current.filter(item => item.sequence !== result.sequence), result].sort((a,b)=>a.sequence-b.sequence));
    }, state => { if(allowed())setLiveState(state); }, {
      store: store.current,
      onRestore: turns => { if(allowed())setTranscripts(turns); },
      onIssue: message => { if(allowed())setError(message); },
    });
    live.current = transcriber;
    void Promise.all([store.current.list(meetingId),store.current.loadMeeting(meetingId)]).then(([segments,saved]) => {
      if (!allowed() || recorder.current?.recordingState.status === "recording" || recorder.current?.recordingState.status === "paused") return;
      if(segments.length) {
        setRecording({ status: "stopped", nextSequence: Math.max(...segments.map(s=>s.sequence))+1, localSequences: segments.map(s=>s.sequence), uploadedSequences: [] });
        setBackupNotice("Bewaarde vergadering hersteld. Je kunt de opname exporteren of hervatten. De tijd tussen sluiten en hervatten is niet opgenomen.");
      }
      if(saved) {
        const isReviewed = segments.length>0 && saved.reviewedAudioCount === segments.length && !!saved.transcripts;
        setTranscripts(isReviewed ? saved.transcripts! : (saved.live?.turns ?? []).map(t=>({...t,replayed:true})));
        setNotes(saved.notes);setBriefingSnapshot(saved.briefing);setReviewed(isReviewed);
      }
    }).catch(cause=>{if(allowed())setError(String(cause));}).finally(()=>{if(!cancelled)setRestoring(false);});
    return () => {cancelled=true;transcriber.close();};
  }, [meetingId, user?.uid]);

  async function refreshSaved() { setSavedMeetings(await store.current.meetings()); }

  useEffect(() => onAuthStateChanged(auth, (currentUser) => {
    setUser(currentUser);
    if (!canUseApp(currentUser)) {
      setTranscripts([]);
      setBriefingSnapshot(undefined);
      setNotes(undefined);
      endingMeeting.current = true;live.current?.close();
      setReviewed(false);
      void recorder.current?.stop().then(() => {
        setRecording(recorder.current?.recordingState ?? initialState);
      }).catch(cause=>setError(String(cause)));
    }
  }), []);

  useEffect(() => {
    if (canUseApp(user)) void refreshSaved().catch(cause=>setError(String(cause)));
    const retry = () => { if (canUseApp(auth.currentUser) && !consultingRef.current && !endingMeeting.current && recorder.current?.recordingState.status === "recording") live.current?.reconnect(); };
    const offline = () => { if(canUseApp(auth.currentUser) && !consultingRef.current && !endingMeeting.current && recorder.current?.recordingState.status === "recording")live.current?.reconnect(); };
    window.addEventListener("online", retry); window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", retry); window.removeEventListener("offline", offline); };
  }, [user]);

  useEffect(() => {
    const instance = new BrowserRecorder({
      store: store.current,
      onAudio: samples => {
        const now = Date.now();
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / Math.max(1, samples.length));
        speech.current.lastFrameAt = now;
        if (rms >= 0.008) { speech.current.lastSpeechAt = now; live.current?.noteSpeech(); }
      },
      onSegment: segment => { setRecording(instance.recordingState); setReviewed(false); live.current?.notifySavedAudio(segment); },
      onError: cause => { setError(cause.message); setRecording({ ...instance.recordingState, status: "stopped" }); live.current?.close(); },
    });
    recorder.current = instance;
    return () => { live.current?.close(); void instance.stop().catch(()=>undefined); };
  }, []);

  useEffect(() => {
    const guard = new RecordingWakeLock(setWakeActive);wake.current=guard;
    return () => {guard.dispose();wake.current=null;};
  }, []);
  useEffect(() => {
    const active = recording.status === "recording";
    wake.current?.setActive(active);
    if(!active)return;
    const timer=setInterval(()=>void checkStorage(15*60*1000).then(setStorageCheck),60000);
    return ()=>clearInterval(timer);
  }, [recording.status]);
  useEffect(() => {
    if(!["recording","paused"].includes(recording.status))return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);
  }, [recording.status]);
  function checkpointIssue() { setBackupNotice("De laatste tekst of notulen konden niet lokaal worden bewaard. De audio-opslag staat hier los van; exporteer de opname als back-up."); }

  async function ensureReview(): Promise<TranscriptResult[]> {
    if (reviewPromise.current) return reviewPromise.current;
    if (recorder.current?.recordingState.status === "recording" || recorder.current?.recordingState.status === "paused") throw new Error("Rond de opname eerst af voor de definitieve controle.");
    if (!canUseApp(auth.currentUser)) throw new Error("Log eerst in.");
    if (navigator.onLine === false) throw new Error("Je bent offline. De audio is lokaal bewaard; controleer de transcriptie zodra je weer online bent.");
    setReviewing(true); setError(undefined);
    const task = (async () => {
      const segments = await store.current.list(meetingId);
      const result = await reviewRecording(meetingId, segments, (done,total) => {
        if(sessionIdRef.current === meetingId)setProgress({done,total});
      }, () => sessionIdRef.current === meetingId && canUseApp(auth.currentUser));
      if(sessionIdRef.current === meetingId && canUseApp(auth.currentUser)) {
        setTranscripts(result);setReviewed(true);setRecording(current=>({...current,uploadedSequences:segments.map(s=>s.sequence)}));
        await store.current.saveMeeting(meetingId,{transcripts:result,reviewedAudioCount:segments.length}).catch(checkpointIssue);
      }
      return result;
    })();
    reviewPromise.current = task;
    try { return await task; } finally { reviewPromise.current=null; setReviewing(false); }
  }

  function changeConsultation(active: boolean) {
    consultingRef.current = active;setConsulting(active);
    if (active) live.current?.close();
    else if (!endingMeeting.current && canUseApp(auth.currentUser) && recorder.current?.recordingState.status === "recording") void live.current?.start();
  }

  async function startOrResume(allowLimitedStorage = false) {
    if(restoring)return;
    setError(undefined); setTransitioning(true);

    try {
      if (!canUseApp(auth.currentUser)) throw new Error("Dit account heeft geen toegang tot deze app.");
      const segments = await store.current.list(meetingId);
      const duration = segments.reduce((n,s)=>n+s.durationMs,0);
      const storage = await checkStorage(Math.max(0,FOUR_HOURS_MS-duration),true);
      setStorageCheck(storage);
      if(storage.status === "low" && !allowLimitedStorage) {setLimitedStorage(true);return;}
      setLimitedStorage(false);
      endingMeeting.current = false;
      await recorder.current?.start(meetingId);
      setRecording(recorder.current?.recordingState ?? initialState); setReviewed(false);
      if (!consultingRef.current) void live.current?.start();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Opname kon niet starten.");
    } finally { setTransitioning(false); }
  }

  async function signIn() {
    setError(undefined);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google-login mislukt.");
    }
  }

  async function pause() {
    setTransitioning(true);
    try { await recorder.current?.pause(); await live.current?.finish(); setRecording(recorder.current?.recordingState ?? initialState); }
    catch(cause) {
      await recorder.current?.stop().catch(()=>undefined);live.current?.close();setRecording(recorder.current?.recordingState ?? initialState);
      setError(cause instanceof Error ? cause.message : "Pauzeren mislukt.");
    }
    finally { setTransitioning(false); }
  }

  async function stop() {
    setTransitioning(true); setError(undefined); endingMeeting.current=true;setStopSignal(value=>value+1);
    try {
      try { await recorder.current?.stop(); }
      finally {
        setRecording(recorder.current?.recordingState ?? initialState);
        await live.current?.finish();
      }
      await refreshSaved();
      const segments = await store.current.list(meetingId);
      if(segments.length)await ensureReview();
    } catch(cause) { setError(cause instanceof Error ? cause.message : "Afronden mislukt. De lokale audio blijft bewaard."); }
    finally { setTransitioning(false); }
  }

  function retryTranscriptie() {
    if (isRecording) live.current?.reconnect();
    else void ensureReview().catch(cause=>setError(cause instanceof Error ? cause.message : "Controle mislukt."));
  }

  async function restoreMeeting(id: string) {
    if(isRecording || isPaused || reviewing || notesLoading || transitioning || restoring || exporting)return;
    const previous=savedMeetings.find(s=>s.id===id); if(!previous)return;
    setSession({id,startedAt:previous.startedAt}); setRecording(initialState); setTranscripts([]);setBriefingSnapshot(undefined); setNotes(undefined); setReviewed(false); setError(undefined);setLimitedStorage(false);setStorageCheck(undefined);setBackupNotice(undefined);
  }

  function startNewSession() {
    if (isRecording || isPaused || reviewing || notesLoading || transitioning || restoring || exporting) return;
    setSession({ id: createSessionId(), startedAt: Date.now() });
    setRecording(initialState);
    setTranscripts([]);setBriefingSnapshot(undefined);
    setNotes(undefined);
    setReviewed(false);
    setError(undefined);setLimitedStorage(false);setStorageCheck(undefined);setBackupNotice(undefined);
  }

  async function generateNotes() {
    setError(undefined);
    setNotesLoading(true);
    try {
      if (!canUseApp(auth.currentUser)) throw new Error("Dit account heeft geen toegang tot deze app.");
      if(!reviewed) await ensureReview();
      if(!canUseApp(auth.currentUser) || sessionIdRef.current !== meetingId)return;
      const generated = await createMeetingNotes(meetingId);
      if (sessionIdRef.current === meetingId && canUseApp(auth.currentUser)) {
        setNotes(generated);await store.current.saveMeeting(meetingId,{notes:generated}).catch(checkpointIssue);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notulen maken mislukt.");
    } finally {
      setNotesLoading(false);
    }
  }

  async function exportAudio() {
    setExporting(true);setError(undefined);
    try {
      if(await exportRecording(meetingId,()=>store.current.list(meetingId)))setBackupNotice("De audio-export is opgeslagen of als download aangeboden. Controleer het bestand op je apparaat.");
    } catch(cause) {setError(cause instanceof Error?cause.message:"Exporteren mislukt; de lokale opname blijft bewaard.");}
    finally {setExporting(false);}
  }
  function exportText() {
    downloadBlob(new Blob([JSON.stringify({version:1,meetingId,session,transcripts,notes,briefing:briefingSnapshot},null,2)],{type:"application/json"}),`${meetingId}-tekst-en-notulen.json`);
  }

  async function signOutAccount() {
    setError(undefined);
    try {
      endingMeeting.current=true;live.current?.close(); await recorder.current?.stop();
      await signOut(auth);
      setRecording(initialState);
      setTranscripts([]);
      setBriefingSnapshot(undefined);
      setNotes(undefined);
      live.current?.close();
      setReviewed(false);
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
        <h1>Je vergadering, met je notulist.</h1>
        <p className="intro">
          Neem op, volg de tekst en overleg tussendoor. Na afloop controleren we de transcriptie voor de notulen.
        </p>
        <div className="account-row">
          {user ? <span>Ingelogd als {user.email ?? user.displayName ?? "Google-gebruiker"}</span> : <span>Log in voor OpenAI-transcriptie.</span>}
          {user && <button className="secondary-button" onClick={() => void signOutAccount()}>Uitloggen</button>}
          {!user && <button className="secondary-button" onClick={() => void signIn()}>Log in met Google</button>}
        </div>
        <div className="session-row">
          <span>Sessie gestart {new Date(session.startedAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}</span>
          <button className="secondary-button" onClick={startNewSession} disabled={isRecording || isPaused || notesLoading || reviewing || transitioning || restoring || exporting}>
            Nieuwe sessie
          </button>
        </div>

        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="meeting-workspace" aria-label="Vergadering en notulist">
        <div className="record-actions">
          {!isRecording && (
            <button className="record-button" onClick={() => void startOrResume()} disabled={!canUseApp(user) || reviewing || notesLoading || transitioning || restoring || exporting}>
              {isPaused || recording.localSequences.length>0 ? "Hervat vergadering" : "Start vergadering"}
            </button>
          )}
          {isRecording && <button className="secondary-button" onClick={() => void pause()} disabled={transitioning}>Pauzeer</button>}
          {(isRecording || isPaused) && <button className="secondary-button" onClick={() => void stop()} disabled={transitioning}>Rond vergadering af</button>}
          {!isRecording && !isPaused && recording.localSequences.length>0 && <button className="secondary-button" disabled={exporting || restoring || (transitioning && !reviewing)} onClick={()=>void exportAudio()}>{exporting?"Opname exporteren…":"Download opname"}</button>}
          {(transcripts.length>0 || notes) && <button className="secondary-button" onClick={exportText}>Download tekstback-up</button>}
        </div>
        {restoring && <p role="status">Bewaarde vergadering herstellen…</p>}
        {limitedStorage && !isRecording && <div className="storage-warning" role="alert"><p>Er lijkt onvoldoende vrije opslag voor de resterende opname tot vier uur met reserve. Maak ruimte vrij of exporteer eerdere opnamen.</p><button className="secondary-button" disabled={transitioning || restoring || exporting} onClick={()=>void startOrResume(true)}>Toch starten met beperkte opslag</button></div>}
        {storageCheck?.status === "unknown" && <p className="muted">Vrije opslag kon niet worden gecontroleerd. Houd ruimte vrij voor ongeveer 700 MB audio bij vier uur opname.</p>}
        {isRecording && storageCheck?.status === "low" && <p role="alert">De vrije opslag wordt krap. Rond af en exporteer de opname voordat de opslag vol raakt.</p>}
        {isRecording && <p className="muted">{wakeActive?"Scherm wakker houden is actief.":"Scherm wakker houden is niet actief. Houd de app zichtbaar en voorkom dat het apparaat vergrendelt."} Sluit het apparaat aan op stroom.</p>}
        {backupNotice && <p role="status">{backupNotice}</p>}
      <div className="meeting-workspace-heading"><h2>Deze vergadering</h2><p>{isRecording ? "Opname loopt · overleg gerust tussendoor" : isPaused ? "Opname gepauzeerd · overleg blijft beschikbaar" : "Opname, tekst en overleg op één plek"}</p></div>
      <VoicePanel key={meetingId} meetingId={meetingId} transcripts={transcripts} notes={notes} stopSignal={stopSignal} getMicrophone={() => recorder.current?.cloneMicrophone()} recording={isRecording} initialBriefing={briefingSnapshot} onBriefingUpdated={summary=>{setBriefingSnapshot(summary);void store.current.saveMeeting(meetingId,{briefing:summary}).catch(checkpointIssue);}} onConsultationChange={changeConsultation} liveAvailable={liveState === "live"} getSpeechActivity={() => ({ ...speech.current, transcriptPending: live.current?.unsettled ?? true })}
        onNotesUpdated={(updated) => { if (sessionIdRef.current === updated.meetingId) {setNotes(updated);void store.current.saveMeeting(meetingId,{notes:updated}).catch(checkpointIssue);} }} />

      <section className="transcript-card">
        <div className="transcript-heading">
          <div><span className="label">Transcriptie</span><h2>Live tekst</h2></div>
          <div className="queue-actions">
            <span>{consulting && isRecording ? "Live tekst gepauzeerd · overleg met Kneut" : reviewed ? "Na afloop verwerkt" : liveState === "live" ? "Live · voorlopig" : liveState === "blocked" ? "Live herstel vraagt aandacht" : liveState === "recovering" ? "Tekst inhalen · Kneut wacht" : liveState === "connecting" ? "Live verbinding maken…" : "Lokale audio beschikbaar"}</span>
            {(liveState === "offline" || liveState === "blocked" || (!isRecording && recording.localSequences.length>0)) && <button className="retry-button" disabled={reviewing || transitioning || isPaused} onClick={retryTranscriptie}>{isRecording ? "Live tekst herstellen" : "Transcript opnieuw controleren"}</button>}
            {!isRecording && !isPaused && recording.localSequences.length>0 && <button className="secondary-light-button" onClick={() => void generateNotes()} disabled={notesLoading || reviewing || transitioning || restoring || exporting}>{notesLoading ? "Notulen maken…" : "Maak definitieve notulen"}</button>}

          </div>
        </div>
        {transcripts.length === 0 ? <p className="muted">Start de vergadering. De tekst verschijnt doorlopend en is voorlopig tot de controle na afloop.</p> : transcripts.map((transcript) => (
          <p className="transcript-line" key={transcript.sequence}><span>{transcript.provisional ? "Live" : `#${transcript.sequence}`}</span>{transcript.text}{transcript.overlapUncertain && <small className="transcript-warning">Overlap bij deze grens controleren; er is geen tekst stilzwijgend verwijderd.</small>}</p>
        ))}
      </section>

      {liveState === "recovering" && <p role="status">Tekst bijwerken: {Math.floor((live.current?.progress?.processedMs ?? 0)/60000)} van {Math.ceil((live.current?.progress?.availableMs ?? 0)/60000)} minuten audio verwerkt. Kneut wacht op actuele tekst.</p>}
      {liveState === "offline" && <p className="muted" role="status">Live tekst is onderbroken. De opname blijft lokaal doorlopen. De verbinding wordt automatisch hersteld en opgeslagen audio wordt ingehaald; Kneut wacht totdat de tekst is bijgewerkt.</p>}
      {reviewing && <p role="status">Transcriptie controleren vanuit de opname: {progress.done} van {progress.total || "…"} vensters. Je kunt hierna definitieve notulen maken.</p>}
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

      </section>

      {savedMeetings.length>0 && <section className="transcript-card"><label htmlFor="restore-meeting">Lokaal bewaarde vergadering openen</label><select id="restore-meeting" value={meetingId} disabled={isRecording || isPaused || reviewing || notesLoading || transitioning || restoring || exporting} onChange={event=>void restoreMeeting(event.target.value)}><option value={meetingId}>Deze vergadering</option>{savedMeetings.filter(item=>item.id!==meetingId).map(item=><option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString("nl-NL")} · {item.count} audioblokken</option>)}</select><p className="muted">De audio blijft op dit apparaat staan. Open een bewaarde opname om die later te controleren of te herstellen.</p></section>}


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
          <strong>{reviewed ? "Gecontroleerd" : `${recording.localSequences.length} blokken bewaard`}</strong>
        </div>
      </section>

      <section className="feature-grid">
        <article><span>01</span><h2>Offline veilig</h2><p>Audiosegmenten gaan direct naar lokale IndexedDB-opslag.</p></article>
        <article><span>02</span><h2>Live scherp</h2><p>Doorlopende live tekst voedt hetzelfde overleg met de notulist; de definitieve controle gebruikt de lokale audio.</p></article>
        <article><span>03</span><h2>Actiegericht</h2><p>Eigenaar en deadline worden gecontroleerd voordat een actiepunt klaar is.</p></article>
      </section>
    </main>
  );
}
