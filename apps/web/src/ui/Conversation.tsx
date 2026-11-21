import { useEffect, type CSSProperties } from "react";
import { Core } from "../core/Core.js";
import { stateLabel } from "../conversation/assistant-state.js";
import type { Session } from "../conversation/session.js";
import { useAssistantAnnouncement, useSnapshot, useVisibleViewport } from "../hooks.js";
import { uploadAttachment } from "../tasks/attachments.js";
import { CallScreen } from "./CallScreen.js";
import { Composer } from "./Composer.js";
import { Thread } from "./Thread.js";

interface Props {
  session: Session;
  onLogout?(): void;
  demo?: boolean;
}

export function Conversation({ session, onLogout, demo }: Props) {
  const snapshot = useSnapshot(session);
  const viewport = useVisibleViewport();
  const announcement = useAssistantAnnouncement(snapshot.thread.messages);
  const label = stateLabel(snapshot.state);
  const online = snapshot.connection === "ready";
  const voice = snapshot.capabilities?.stt === true;
  const speech = snapshot.capabilities?.tts === true;
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
  const frame: CSSProperties | undefined = viewport && keyboardOpen ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` } : undefined;

  return (
    <div className={`app${keyboardOpen ? " keyboard-open" : ""}`} style={frame}>
      <header className="topbar">
        <h1 className="wordmark">J.A.R.V.IS</h1>
        <p className="state-pill" data-state={snapshot.state} role="status">
          {label}
        </p>
        <div className="topbar-actions">
          {speech && (
            <button
              type="button"
              className="button icon ghost"
              aria-pressed={snapshot.speakerOn}
              aria-label={snapshot.speakerOn ? "Respuestas en voz alta: tocá para silenciar" : "Respuestas en silencio: tocá para escucharlas"}
              onClick={() => session.toggleSpeaker()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
                {snapshot.speakerOn ? (
                  <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4ZM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54Z" />
                ) : (
                  <path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z" />
                )}
              </svg>
            </button>
          )}
          <button type="button" className="button quiet" onClick={() => session.newConversation()} disabled={!online}>
            Nueva
          </button>
          {onLogout && (
            <button type="button" className="button quiet" onClick={onLogout}>
              Salir
            </button>
          )}
        </div>
      </header>
      {!snapshot.callActive && (
        <section className="stage">
          <Core
            state={snapshot.state}
            label={label}
            getLevels={session.getLevels}
            onActivate={voice && online ? () => void session.startCall() : undefined}
            activateLabel="Llamar a J.A.R.V.IS"
          />
          {voice && online && !keyboardOpen && <p className="stage-hint">Tocá el núcleo para hablar</p>}
          {demo && <p className="demo-badge">Modo demo: datos ficticios</p>}
        </section>
      )}
      <Thread thread={snapshot.thread} actions={session} onLoadOlder={() => session.loadOlder()} />
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {snapshot.audioBlocked && (
        <div className="banner" role="status">
          <span>El navegador bloqueó el audio.</span>
          <button type="button" className="button primary" onClick={() => void session.enableAudio()}>
            Activar audio
          </button>
        </div>
      )}
      {notice && (
        <div className={`banner banner-${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
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
        onAttach={demo ? undefined : uploadAttachment}
      />
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
