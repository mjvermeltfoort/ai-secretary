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
  const [audioDuration, setAudioDuration] = useState(0);
  const meetingMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!meetingMenu.current?.contains(event.target as Node)) meetingMenu.current?.removeAttribute("open"); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && meetingMenu.current?.open) { meetingMenu.current.removeAttribute("open"); meetingMenu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
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
      setAudioDuration(segments.reduce((total, segment) => total + segment.durationMs, 0));
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
      onSegment: segment => { setAudioDuration((segment.startMs ?? 0) + segment.durationMs); setRecording(instance.recordingState); setReviewed(false); live.current?.notifySavedAudio(segment); },
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

  const liveContent = (<section className="transcript-card">
        <div className="transcript-heading">
          <h2>Live tekst</h2>
          <div className="queue-actions">
            <span>{consulting && isRecording ? "Live tekst gepauzeerd · overleg met Kneut" : reviewed ? "Na afloop verwerkt" : liveState === "live" ? "Live · voorlopig" : liveState === "blocked" ? "Live herstel vraagt aandacht" : liveState === "recovering" ? "Tekst inhalen · Kneut wacht" : liveState === "connecting" ? "Live verbinding maken…" : "Lokale audio beschikbaar"}</span>
            {(liveState === "offline" || liveState === "blocked" || (!isRecording && recording.localSequences.length>0)) && <button className="retry-button" disabled={reviewing || transitioning || isPaused} onClick={retryTranscriptie}>{isRecording ? "Live tekst herstellen" : "Transcript opnieuw controleren"}</button>}
          </div>
        </div>
        {transcripts.length === 0 ? <p className="muted">De tekst verschijnt zodra de vergadering begint.</p> : transcripts.map((transcript) => (
          <p className="transcript-line" key={transcript.sequence}>{transcript.text}{transcript.overlapUncertain && <small className="transcript-warning">Overlap bij deze grens controleren; er is geen tekst stilzwijgend verwijderd.</small>}</p>
        ))}
  </section>);
  const notesContent = (<div className="notes-content">
    {!isRecording && !isPaused && recording.localSequences.length>0 && <button className="secondary-light-button" onClick={() => void generateNotes()} disabled={notesLoading || reviewing || transitioning || restoring || exporting}>{notesLoading ? "Notulen maken…" : "Maak definitieve notulen"}</button>}
      {notes && <section className="notes-card">
        <div className="transcript-heading">
          <h2>Notulen</h2>
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
{!notes && <p className="muted">{isRecording || isPaused ? "Rond de vergadering af om definitieve notulen te maken." : "De definitieve notulen verschijnen hier na het verwerken van de opname."}</p>}
</div>);

  return (
    <main className="shell">
      <header className="meeting-header">
        <div><h1>Kneut <span>· Vergadering</span></h1>
          <p className={`recording-status ${isRecording ? "is-recording" : ""}`} ><span className="status-dot" aria-hidden="true" /><span role="status">{isRecording ? "Opname loopt" : isPaused ? "Gepauzeerd" : recording.localSequences.length ? "Opname afgerond" : "Klaar om te beginnen"}</span><span className="recording-time" aria-label="Opgenomen tijd">{new Date(audioDuration).toISOString().slice(11,19)}</span></p>
        </div>
        <details className="meeting-menu" ref={meetingMenu}>
          <summary aria-label="Vergaderopties" title="Vergaderopties">⋮</summary>
          <div className="meeting-menu-content" onClick={event=>{if((event.target as HTMLElement).closest("button"))meetingMenu.current?.removeAttribute("open");}}>
            <button className="menu-button" onClick={startNewSession} disabled={isRecording || isPaused || notesLoading || reviewing || transitioning || restoring || exporting}>Nieuwe vergadering</button>
            {savedMeetings.length>0 && <div className="menu-group"><label htmlFor="restore-meeting">Eerdere vergaderingen</label><select id="restore-meeting" value={meetingId} disabled={isRecording || isPaused || reviewing || notesLoading || transitioning || restoring || exporting} onChange={event=>{void restoreMeeting(event.target.value);meetingMenu.current?.removeAttribute("open");}}><option value={meetingId}>Deze vergadering</option>{savedMeetings.filter(item=>item.id!==meetingId).map(item=><option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString("nl-NL")}</option>)}</select></div>}
            {!isRecording && !isPaused && recording.localSequences.length>0 && <button className="menu-button" disabled={exporting || restoring || (transitioning && !reviewing)} onClick={()=>void exportAudio()}>{exporting?"Opname exporteren…":"Download opname"}</button>}
            {(transcripts.length>0 || notes) && <button className="menu-button" onClick={exportText}>Download tekstback-up</button>}
            <details className="menu-help"><summary>Help</summary><p>Zeg ‘Kneut’ om met de notulist te praten. Terug naar meeluisteren hervat de live tekst.</p><p>Opnamen blijven op dit apparaat. Download een back-up voordat je browsergegevens wist. Houd de app zichtbaar en sluit het apparaat aan op stroom.</p><p>Transcriptie, samenvatten en overleg gebruiken je OpenAI-budget. Een gesprek stopt na vijf minuten; je kunt daarna opnieuw verbinden. De opname loopt door.</p><p>Gebruik oortjes om de AI-stem uit de opname te houden. AI-antwoorden zijn geen vergaderbesluiten. Controleer na afloop de tekst en notulen.</p></details>
            <div className="menu-group"><span className="account-name">{user?.email ?? user?.displayName}</span><button className="menu-button" onClick={()=>void signOutAccount()}>Uitloggen</button></div>
          </div>
        </details>
      </header>
      <section className="meeting-workspace" aria-label="Vergadering en notulist">
        <div className="record-actions">
          {!isRecording && <button className="record-button" onClick={()=>void startOrResume()} disabled={!canUseApp(user) || reviewing || notesLoading || transitioning || restoring || exporting}>{isPaused || recording.localSequences.length>0 ? "Hervat vergadering" : "Start vergadering"}</button>}
          {isRecording && <button className="secondary-button" onClick={()=>void pause()} disabled={transitioning}>Pauzeer</button>}
          {(isRecording || isPaused) && <button className="finish-button" onClick={()=>void stop()} disabled={transitioning}>Afronden</button>}
        </div>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        {restoring && <p role="status">Vergadering herstellen…</p>}
        {limitedStorage && !isRecording && <div className="storage-warning" role="alert"><p>Onvoldoende vrije opslag voor een lange opname. Maak ruimte vrij of download eerdere opnamen.</p><button className="secondary-button" disabled={transitioning || restoring || exporting} onClick={()=>void startOrResume(true)}>Toch starten met beperkte opslag</button></div>}
        {storageCheck?.status === "unknown" && <p className="attention-note">Vrije opslag onbekend. Houd ongeveer 700 MB vrij voor vier uur opname.</p>}
        {isRecording && storageCheck?.status === "low" && <p className="attention-note" role="alert">Opslag bijna vol. Rond af en download de opname.</p>}
        {isRecording && !wakeActive && <p className="attention-note">Houd de app zichtbaar en voorkom schermvergrendeling.</p>}
        {backupNotice && <p className="attention-note" role="status">{backupNotice}</p>}
        {liveState === "recovering" && <p role="status">Live tekst wordt bijgewerkt. Kneut wacht op actuele tekst.</p>}
        {liveState === "offline" && isRecording && !consulting && <p role="status">Live tekst onderbroken. De opname loopt door; de verbinding wordt automatisch hersteld.</p>}
        {liveState === "blocked" && <p role="alert">Live tekst vraagt aandacht. Open Live tekst om te herstellen.</p>}
        {reviewing && <p role="status">Transcriptie controleren: {progress.done} van {progress.total || "…"} delen.</p>}
      <VoicePanel key={meetingId} meetingId={meetingId} transcripts={transcripts} notes={notes} stopSignal={stopSignal} getMicrophone={() => recorder.current?.cloneMicrophone()} recording={isRecording} initialBriefing={briefingSnapshot} onBriefingUpdated={summary=>{setBriefingSnapshot(summary);void store.current.saveMeeting(meetingId,{briefing:summary}).catch(checkpointIssue);}} onConsultationChange={changeConsultation} liveAvailable={liveState === "live"} getSpeechActivity={() => ({ ...speech.current, transcriptPending: live.current?.unsettled ?? true })}
        liveContent={liveContent} notesContent={notesContent}
        onNotesUpdated={(updated) => { if (sessionIdRef.current === updated.meetingId) {setNotes(updated);void store.current.saveMeeting(meetingId,{notes:updated}).catch(checkpointIssue);} }} />
      </section>
      <details className="recording-details"><summary>Details</summary><dl><div><dt>Gestart</dt><dd>{new Date(session.startedAt).toLocaleString("nl-NL")}</dd></div><div><dt>Opgeslagen audioblokken</dt><dd>{recording.localSequences.length}</dd></div><div><dt>Transcriptiecontrole</dt><dd>{reviewed ? "Gecontroleerd" : "Nog niet gecontroleerd"}</dd></div><div><dt>Scherm wakker houden</dt><dd>{wakeActive ? "Actief" : "Niet actief"}</dd></div></dl></details>
    </main>
  );
}
