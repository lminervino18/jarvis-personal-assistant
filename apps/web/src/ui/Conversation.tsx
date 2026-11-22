import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Core } from "../core/Core.js";
import { stateLabel } from "../conversation/assistant-state.js";
import type { Session } from "../conversation/session.js";
import { useAssistantAnnouncement, useElementHeight, useSnapshot, useVisibleViewport } from "../hooks.js";
import { uploadAttachment } from "../tasks/attachments.js";
import { BuildScreen } from "./BuildScreen.js";
import { CallScreen } from "./CallScreen.js";
import { Composer } from "./Composer.js";
import { SettingsSheet } from "./SettingsSheet.js";
import { Thread } from "./Thread.js";

interface Props {
  session: Session;
  onLogout?(): void;
  demo?: boolean;
}

const COMPOSER_FALLBACK_PX = 68;

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
      {on ? (
        <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4ZM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54Z" />
      ) : (
        <path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z" />
      )}
    </svg>
  );
}

export function Conversation({ session, onLogout, demo }: Props) {
  const snapshot = useSnapshot(session);
  const viewport = useVisibleViewport();
  const announcement = useAssistantAnnouncement(snapshot.thread.messages);
  const composer = useRef<HTMLDivElement>(null);
  const composerHeight = useElementHeight(composer, COMPOSER_FALLBACK_PX);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const refreshBuild = useCallback(() => session.refreshBuild(), [session]);
  const closeBuild = useCallback(() => setBuildOpen(false), []);
  const label = stateLabel(snapshot.state);
  const online = snapshot.connection === "ready";
  const voice = snapshot.capabilities?.stt === true;
  const speech = snapshot.capabilities?.tts === true;
  const startCall = voice && online ? () => void session.startCall() : undefined;
  const empty = snapshot.thread.messages.length === 0 && !snapshot.thread.hasMore && !snapshot.thread.transcript;
  const { notice } = snapshot;

  useEffect(() => {
    const wake = () => !document.hidden && session.wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [session]);

  useEffect(() => {
    if (!notice || notice.level === "error") return;
    const timer = setTimeout(() => session.dismissNotice(), 9000);
    return () => clearTimeout(timer);
  }, [notice, session]);

  const keyboardOpen = viewport?.keyboardOpen === true;

  useEffect(() => {
    if (!keyboardOpen) window.scrollTo(0, 0);
  }, [keyboardOpen]);

  const size: CSSProperties =
    viewport && keyboardOpen
      ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` }
      : viewport?.screenHeight
        ? { height: viewport.screenHeight }
        : {};
  const frame = { "--composer-h": `${composerHeight}px`, ...size } as CSSProperties;

  return (
    <div className={`app${keyboardOpen ? " keyboard-open" : ""}`} style={frame}>
      <Thread thread={snapshot.thread} actions={session} onLoadOlder={() => session.loadOlder()} />

      {empty && (
        <section className="hero" aria-label="Inicio">
          <Core state={snapshot.state} label={label} getLevels={session.getLevels} onActivate={startCall} activateLabel="Hablar con Jarvis" />
          <h2 className="hero-title">{snapshot.ownerName ? `Hola, ${snapshot.ownerName}` : "Hola"}</h2>
          <p className="hero-subtitle">{startCall ? "Tocá el núcleo para hablar, o escribime." : "Escribime abajo."}</p>
        </section>
      )}

      <header className="topbar">
        <div className="title-pill glass">
          {!empty && (
            <Core state={snapshot.state} label={label} getLevels={session.getLevels} onActivate={startCall} activateLabel="Llamar a Jarvis" />
          )}
          <div className="title-text">
            <h1>Jarvis</h1>
            <p role="status" data-state={snapshot.state} data-online={online}>
              {online ? label : "Sin conexión"}
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          {speech && (
            <button
              type="button"
              className="glass-button glass"
              aria-pressed={snapshot.speakerOn}
              aria-label={snapshot.speakerOn ? "Respuestas en voz alta: tocá para silenciar" : "Respuestas en silencio: tocá para escucharlas"}
              onClick={() => session.toggleSpeaker()}
            >
              <SpeakerIcon on={snapshot.speakerOn} />
            </button>
          )}
          <button type="button" className="glass-button glass" aria-label="Construir" aria-haspopup="dialog" onClick={() => setBuildOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <path
                fill="currentColor"
                d="m13.8 3.2 1.4 1.4-1.1 1.1 4.2 4.2 1.1-1.1 1.4 1.4-3.5 3.5-1.4-1.4 1.1-1.1-1.4-1.4-8.5 8.5a1 1 0 0 1-1.4 0l-1.4-1.4a1 1 0 0 1 0-1.4l8.5-8.5-1.4-1.4-1.1 1.1-1.4-1.4z"
              />
            </svg>
          </button>
          <button type="button" className="glass-button glass" aria-label="Ajustes" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <circle cx="5" cy="12" r="2" fill="currentColor" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <circle cx="19" cy="12" r="2" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      <div className="dock" ref={composer}>
        {snapshot.audioBlocked && (
          <div className="banner glass" role="status">
            <span>El navegador bloqueó el audio.</span>
            <button type="button" className="button primary" onClick={() => void session.enableAudio()}>
              Activar audio
            </button>
          </div>
        )}
        {notice && (
          <div className={`banner glass banner-${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            <button type="button" className="button quiet" onClick={() => session.dismissNotice()}>
              Cerrar
            </button>
          </div>
        )}
        <Composer
          online={online}
          busy={snapshot.busy}
          recording={snapshot.recordingNote}
          onSend={(text) => session.sendText(text)}
          onNoteStart={() => void session.startVoiceNote()}
          onNoteEnd={(send) => session.finishVoiceNote(send)}
          onStop={() => session.stopAll()}
          onCall={startCall}
          onAttach={demo ? undefined : uploadAttachment}
        />
      </div>

      {settingsOpen && (
        <SettingsSheet
          speech={speech}
          speakerOn={snapshot.speakerOn}
          online={online}
          demo={demo}
          onToggleSpeaker={() => session.toggleSpeaker()}
          onEnablePush={() => session.enablePush()}
          onNewConversation={() => session.newConversation()}
          onLogout={onLogout}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {buildOpen && (
        <BuildScreen
          tasks={snapshot.buildTasks}
          online={online}
          notice={notice}
          actions={session}
          onRefresh={refreshBuild}
          onRequest={(text) => session.requestBuild(text)}
          onReply={(taskId, text) => session.buildFeedback(taskId, text)}
          onClose={closeBuild}
        />
      )}

      {snapshot.callActive && (
        <CallScreen
          state={snapshot.state}
          label={label}
          muted={snapshot.callMuted}
          getLevels={session.getLevels}
          onMute={() => void session.toggleCallMute()}
          onHangUp={() => session.endCall()}
        />
      )}
    </div>
  );
}
