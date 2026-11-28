import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Core } from "../core/Core.js";
import { stateLabel } from "../conversation/assistant-state.js";
import type { Session, SessionSnapshot } from "../conversation/session.js";
import { voiceSubtitle } from "../conversation/subtitle.js";
import { measureViewport, useAssistantAnnouncement, useElapsed, useElementHeight, useMediaQuery, useSnapshot, useViewportRecovery, useVisibleViewport } from "../hooks.js";
import { BuildScreen } from "./BuildScreen.js";
import { CallScreen } from "./CallScreen.js";
import { ChatView } from "./ChatView.js";
import { GlassLens } from "./GlassLens.js";
import { GearIcon, HammerIcon, HangUpIcon, MicIcon, TransferIcon } from "./icons.js";
import { Settings, SettingsSheet } from "./SettingsSheet.js";
import { TransfersScreen } from "./TransfersScreen.js";
import { VoiceTraining } from "./VoiceTraining.js";
import { ownerUploads, TRANSFER_ARRIVED } from "../transfers/uploads.js";

interface Props {
  session: Session;
  onLogout?(): void;
  demo?: boolean;
}

type Panel = "jarvis" | "build" | "settings" | "voice" | "transfers";

const PANEL_PATHS: Record<string, Panel> = { "/voz": "voice", "/transferencias": "transfers" };

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

/** The signed-in app: the chat in the middle, with Construir and Configuración one tap away; a sidebar on wide screens. */
export function Conversation({ session, onLogout, demo }: Props) {
  const snapshot = useSnapshot(session);
  const wide = useMediaQuery(WIDE_QUERY);
  const viewport = useVisibleViewport();
  const announcement = useAssistantAnnouncement(snapshot.thread.messages);
  const dock = useRef<HTMLDivElement>(null);
  const composerHeight = useElementHeight(dock, COMPOSER_FALLBACK_PX);
  const [panel, setPanel] = useState<Panel>(() => PANEL_PATHS[window.location.pathname] ?? "jarvis");
  const refreshBuild = useCallback(() => session.refreshBuild(), [session]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const url = (event.data as { type?: unknown; url?: unknown } | null)?.url;
      if (typeof url === "string" && PANEL_PATHS[url]) setPanel(PANEL_PATHS[url]);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);
  const closePanel = useCallback(() => {
    setPanel("jarvis");
    if (window.location.pathname in PANEL_PATHS) window.history.replaceState(null, "", "/");
  }, []);
  const subtitle = useMemo(() => voiceSubtitle(snapshot.thread), [snapshot.thread]);
  const label = stateLabel(snapshot.state);
  const online = snapshot.connection === "ready";
  const call = snapshot.capabilities?.stt === true && online ? () => void session.startCall() : undefined;
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
      chat={snapshot.buildChat}
      online={online}
      notice={notice}
      dictation={snapshot.dictation}
      dictated={snapshot.dictated}
      levels={session.getLevels}
      onDictate={() => void session.startDictation()}
      onDictationStop={(send) => session.stopDictation(send)}
      onDictationCancel={() => session.cancelDictation()}
      onRefresh={refreshBuild}
      onRequest={(text) => session.requestBuild(text)}
      onStop={() => session.stopBuild()}
      onClose={closePanel}
    />
  );

  const settings = {
    speech: snapshot.capabilities?.tts === true,
    speakerOn: snapshot.speakerOn,
    online,
    demo,
    onToggleSpeaker: () => session.toggleSpeaker(),
    onEnablePush: () => session.enablePush(),
    onLogout,
    onTrainVoice: () => setPanel("voice"),
  };

  const voice = (embedded: boolean) => (
    <VoiceTraining embedded={embedded} levels={session.getLevels} onStart={() => session.startSample()} onStop={() => session.stopSample()} onClose={closePanel} />
  );

  const transfers = (embedded: boolean) => <TransfersScreen embedded={embedded} onClose={closePanel} />;

  const chat = (
    <ChatView
      session={session}
      snapshot={snapshot}
      dock={dock}
      hidden={wide && panel !== "jarvis"}
      active={panel === "jarvis"}
      demo={demo}
      onCall={call}
      onTransfer={(files) => {
        ownerUploads.add(files, () => window.dispatchEvent(new Event(TRANSFER_ARRIVED)));
        setPanel("transfers");
      }}
      onOpenTransfers={() => setPanel("transfers")}
    />
  );

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
          <button type="button" className="nav-brand" aria-current={panel === "jarvis" ? "page" : undefined} onClick={() => setPanel("jarvis")}>
            <span aria-hidden="true">
              <Core state={snapshot.state} label={label} getLevels={session.getLevels} />
            </span>
            <span className="title-text">
              <strong>Jarvis</strong>
              <span className="brand-status" data-state={snapshot.state} data-online={online}>
                {online ? label : "Sin conexión"}
              </span>
            </span>
          </button>
          <NavButton active={panel === "transfers"} label="Transferencias" icon={<TransferIcon />} onClick={() => setPanel("transfers")} />
          <NavButton active={panel === "build"} label="Construir" icon={<HammerIcon />} onClick={() => setPanel("build")} />
          <NavButton active={panel === "settings"} label="Configuración" icon={<GearIcon />} onClick={() => setPanel("settings")} />
        </nav>

        <main className="main">
          {panel === "jarvis" && snapshot.callActive && (
            <header className="session-header">
              <CallBar session={session} snapshot={snapshot} label={label} />
            </header>
          )}
          {chat}
          {panel === "build" && build(true)}
          {panel === "voice" && voice(true)}
          {panel === "transfers" && transfers(true)}
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
    <div ref={app} className={`app app-phone${keyboardOpen ? " keyboard-open" : ""}`} style={frame}>
      {chat}

      <header className="topbar">
        <div className="title-pill glass">
          <Core state={snapshot.state} label={label} getLevels={session.getLevels} onActivate={call} activateLabel="Llamar a Jarvis" />
          <div className="title-text">
            <h1>Jarvis</h1>
            <StatusLine snapshot={snapshot} label={label} />
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="glass-button glass" aria-label="Construir" aria-haspopup="dialog" onClick={() => setPanel("build")}>
            <HammerIcon />
          </button>
          <button type="button" className="glass-button glass" aria-label="Configuración" aria-haspopup="dialog" onClick={() => setPanel("settings")}>
            <GearIcon />
          </button>
        </div>
      </header>

      {live}
      {snapshot.callActive && (
        <CallScreen
          state={snapshot.state}
          label={label}
          muted={snapshot.callMuted}
          subtitle={subtitle}
          activity={session.activity}
          getLevels={session.getLevels}
          onMute={() => void session.toggleCallMute()}
          onHangUp={() => session.endCall()}
        />
      )}
      {panel === "settings" && <SettingsSheet {...settings} onClose={closePanel} />}
      {panel === "build" && build(false)}
      {panel === "voice" && voice(false)}
      {panel === "transfers" && transfers(false)}
    </div>
  );
}
