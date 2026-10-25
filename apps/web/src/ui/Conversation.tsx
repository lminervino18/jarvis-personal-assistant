import { useEffect } from "react";
import { Core } from "../core/Core.js";
import { stateLabel } from "../conversation/assistant-state.js";
import type { Session } from "../conversation/session.js";
import { useAssistantAnnouncement, useSnapshot, useViewportHeight } from "../hooks.js";
import { Composer } from "./Composer.js";
import { Thread } from "./Thread.js";

interface Props {
  session: Session;
  onLogout?(): void;
  demo?: boolean;
}

export function Conversation({ session, onLogout, demo }: Props) {
  const snapshot = useSnapshot(session);
  const viewportHeight = useViewportHeight();
  const announcement = useAssistantAnnouncement(snapshot.thread.messages);
  const label = stateLabel(snapshot.state);
  const online = snapshot.connection === "ready";
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

  return (
    <div className="app" style={viewportHeight ? { height: viewportHeight } : undefined}>
      <header className="topbar">
        <h1 className="wordmark">J.A.R.V.I.S.</h1>
        <p className="state-pill" data-state={snapshot.state} role="status">
          {label}
        </p>
        <div className="topbar-actions">
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
      <section className="stage">
        <Core state={snapshot.state} label={label} getLevels={session.getLevels} />
        {demo && <p className="demo-badge">Modo demo: datos ficticios</p>}
      </section>
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
        micOpen={snapshot.micOpen}
        busy={snapshot.busy}
        onSend={(text) => session.sendText(text)}
        onMicrophone={() => void session.toggleMicrophone()}
        onStop={() => session.stopAll()}
      />
    </div>
  );
}
