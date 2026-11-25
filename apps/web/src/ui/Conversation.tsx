import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Core } from "../core/Core.js";
import { stateLabel } from "../conversation/assistant-state.js";
import type { Session, SessionSnapshot } from "../conversation/session.js";
import { voiceSubtitle } from "../conversation/subtitle.js";
import { measureViewport, useAssistantAnnouncement, useElapsed, useElementHeight, useMediaQuery, useSnapshot, useViewportRecovery, useVisibleViewport } from "../hooks.js";
import { BuildScreen } from "./BuildScreen.js";
import { ChatView, Notices } from "./ChatView.js";
import { ChatIcon, GearIcon, HammerIcon, HangUpIcon, MicIcon, PhoneIcon, SpeakerIcon, WaveIcon } from "./icons.js";
import { GlassLens } from "./GlassLens.js";
import { Settings, SettingsSheet } from "./SettingsSheet.js";
import { VoicePanel } from "./VoicePanel.js";

interface Props {
  session: Session;
  onLogout?(): void;
  demo?: boolean;
}

type Tab = "voice" | "chat";
type Panel = "jarvis" | "build" | "settings";

const WIDE_QUERY = "(min-width: 900px)";
const COMPOSER_FALLBACK_PX = 68;

function StatusLine({ snapshot, label }: { snapshot: SessionSnapshot; label: string }) {
  const online = snapshot.connection === "ready";
  return (
    <p role="status" data-state={snapshot.state} data-online={online}>
      {online ? label : "Sin conexión"}
    </p>
  );
}

function SpeakerToggle({ session, on }: { session: Session; on: boolean }) {
  return (
    <button
      type="button"
      className="glass-button glass"
      aria-pressed={on}
      aria-label={on ? "Respuestas en voz alta: tocá para silenciar" : "Respuestas en silencio: tocá para escucharlas"}
      onClick={() => session.toggleSpeaker()}
    >
      <SpeakerIcon on={on} />
    </button>
  );
}

function CallPill({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="call-pill" aria-label="En llamada: volver a la llamada" onClick={onOpen}>
      <PhoneIcon size={14} /> {useElapsed()}
    </button>
  );
}

function CallBar({ session, snapshot, label }: { session: Session; snapshot: SessionSnapshot; label: string }) {
  return (
    <div className="call-bar glass" role="region" aria-label="Llamada con Jarvis">
      <Core state={snapshot.state} label={label} getLevels={session.getLevels} />
      <div className="call-bar-text">
        <strong>En llamada · {useElapsed()}</strong>
        <span>{snapshot.callMuted ? "Micrófono silenciado" : label}</span>
      </div>
      <button type="button" className="glass-button glass" aria-pressed={snapshot.callMuted} aria-label={snapshot.callMuted ? "Activar micrófono" : "Silenciar micrófono"} onClick={() => void session.toggleCallMute()}>
        <MicIcon muted={snapshot.callMuted} />
      </button>
      <button type="button" className="round-button call-hangup" aria-label="Colgar" onClick={() => session.endCall()}>
        <HangUpIcon />
      </button>
    </div>
  );
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick(): void }) {
  return (
    <button type="button" className="nav-item" aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** The signed-in app: voice and chat tabs on a phone, a sidebar with Jarvis, Construir and Configuración on a wide screen. */
export function Conversation({ session, onLogout, demo }: Props) {
  const snapshot = useSnapshot(session);
  const wide = useMediaQuery(WIDE_QUERY);
  const viewport = useVisibleViewport();
  const announcement = useAssistantAnnouncement(snapshot.thread.messages);
  const dock = useRef<HTMLDivElement>(null);
  const composerHeight = useElementHeight(dock, COMPOSER_FALLBACK_PX);
  const [tab, setTab] = useState<Tab>("voice");
  const [panel, setPanel] = useState<Panel>("jarvis");
  const refreshBuild = useCallback(() => session.refreshBuild(), [session]);
  const closePanel = useCallback(() => setPanel("jarvis"), []);
  const subtitle = useMemo(() => voiceSubtitle(snapshot.thread), [snapshot.thread]);
  const label = stateLabel(snapshot.state);
  const online = snapshot.connection === "ready";
  const canTalk = snapshot.capabilities?.stt === true && online;
  const speech = snapshot.capabilities?.tts === true;
  const { notice } = snapshot;

  const startCall = () => {
    setTab("voice");
    void session.startCall();
  };

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
  const app = useRef<HTMLDivElement>(null);
  const reportViewport = useCallback(() => {
    if (app.current) session.reportViewport(measureViewport(app.current));
  }, [session]);
  useViewportRecovery(app, keyboardOpen, online ? reportViewport : undefined);

  const size: CSSProperties = viewport && keyboardOpen ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` } : {};
  const frame = { "--composer-h": `${composerHeight}px`, ...size } as CSSProperties;

  const build = (embedded: boolean) => (
    <BuildScreen
      embedded={embedded}
      tasks={snapshot.buildTasks}
      online={online}
      notice={notice}
      actions={session}
      dictation={snapshot.dictation}
      dictated={snapshot.dictated}
      levels={session.getLevels}
      onDictate={() => void session.startDictation()}
      onDictationStop={(send) => session.stopDictation(send)}
      onDictationCancel={() => session.cancelDictation()}
      onRefresh={refreshBuild}
      onRequest={(text) => session.requestBuild(text)}
      onReply={(taskId, text) => session.buildFeedback(taskId, text)}
      onClose={closePanel}
    />
  );

  const settings = {
    speech,
    speakerOn: snapshot.speakerOn,
    online,
    demo,
    onToggleSpeaker: () => session.toggleSpeaker(),
    onEnablePush: () => session.enablePush(),
    onLogout,
  };

  const live = (
    <>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <GlassLens />
    </>
  );

  if (wide) {
    return (
      <div ref={app} className="app app-wide" style={frame}>
        <nav className="sidebar" aria-label="Secciones">
          <div className="sidebar-brand">
            <Core state={snapshot.state} label={label} getLevels={session.getLevels} onActivate={canTalk && !snapshot.callActive ? startCall : undefined} activateLabel="Llamar a Jarvis" />
            <div className="title-text">
              <h1>Jarvis</h1>
              <StatusLine snapshot={snapshot} label={label} />
            </div>
          </div>
          <NavButton active={panel === "jarvis"} label="Jarvis" icon={<ChatIcon size={20} />} onClick={() => setPanel("jarvis")} />
          <NavButton active={panel === "build"} label="Construir" icon={<HammerIcon />} onClick={() => setPanel("build")} />
          <NavButton active={panel === "settings"} label="Configuración" icon={<GearIcon />} onClick={() => setPanel("settings")} />
        </nav>

        <main className="main">
          {panel === "jarvis" && (
            <header className="session-header">
              {snapshot.callActive ? (
                <CallBar session={session} snapshot={snapshot} label={label} />
              ) : (
                <div className="session-actions">
                  {speech && <SpeakerToggle session={session} on={snapshot.speakerOn} />}
                  <button type="button" className="button call-start-button" disabled={!canTalk} onClick={startCall}>
                    <PhoneIcon size={18} /> Llamar
                  </button>
                </div>
              )}
            </header>
          )}
          <ChatView session={session} snapshot={snapshot} dock={dock} hidden={panel !== "jarvis"} demo={demo} />
          {panel === "build" && build(true)}
          {panel === "settings" && (
            <section className="settings-page" aria-labelledby="settings-page-title">
              <h2 id="settings-page-title">Configuración</h2>
              <Settings {...settings} />
            </section>
          )}
        </main>
        {live}
      </div>
    );
  }

  return (
    <div ref={app} className={`app app-phone tab-${tab}${keyboardOpen ? " keyboard-open" : ""}`} style={frame}>
      {tab === "voice" && (
        <VoicePanel
          state={snapshot.state}
          label={label}
          getLevels={session.getLevels}
          greeting={snapshot.ownerName ? `Hola, ${snapshot.ownerName}` : "Hola"}
          canTalk={canTalk}
          callActive={snapshot.callActive}
          callMuted={snapshot.callMuted}
          voiceNote={snapshot.voiceNote}
          subtitle={subtitle}
          onCall={startCall}
          onHangUp={() => session.endCall()}
          onMute={() => void session.toggleCallMute()}
          onOpenChat={() => setTab("chat")}
          onNoteStart={() => void session.startVoiceNote()}
          onNoteFinish={() => session.finishVoiceNote()}
          onNoteCancel={() => session.cancelVoiceNote()}
        />
      )}
      <ChatView session={session} snapshot={snapshot} dock={dock} hidden={tab !== "chat"} demo={demo} />

      <header className="topbar">
        <div className="title-pill glass">
          {tab === "chat" && <Core state={snapshot.state} label={label} getLevels={session.getLevels} onActivate={canTalk ? startCall : undefined} activateLabel="Llamar a Jarvis" />}
          <div className="title-text">
            <h1>Jarvis</h1>
            <StatusLine snapshot={snapshot} label={label} />
          </div>
        </div>
        {tab === "chat" && snapshot.callActive && <CallPill onOpen={() => setTab("voice")} />}
        <div className="topbar-actions">
          {speech && !snapshot.callActive && <SpeakerToggle session={session} on={snapshot.speakerOn} />}
          <button type="button" className="glass-button glass" aria-label="Construir" aria-haspopup="dialog" onClick={() => setPanel("build")}>
            <HammerIcon />
          </button>
          <button type="button" className="glass-button glass" aria-label="Configuración" aria-haspopup="dialog" onClick={() => setPanel("settings")}>
            <GearIcon />
          </button>
        </div>
      </header>

      {tab === "voice" && (
        <div className="voice-notices">
          <Notices session={session} snapshot={snapshot} />
        </div>
      )}

      <nav className="tabbar glass" aria-label="Vistas">
        <button type="button" className="tab" aria-current={tab === "voice" ? "page" : undefined} onClick={() => setTab("voice")}>
          <WaveIcon />
          <span>Llamada</span>
        </button>
        <button type="button" className="tab" aria-current={tab === "chat" ? "page" : undefined} onClick={() => setTab("chat")}>
          <ChatIcon />
          <span>Chat</span>
        </button>
      </nav>

      {live}
      {panel === "settings" && <SettingsSheet {...settings} onClose={closePanel} />}
      {panel === "build" && build(false)}
    </div>
  );
}
