import { useEffect, useRef } from "react";
import type { BuildChatState } from "@jarvis/contracts";
import { Markdown } from "../conversation/markdown.js";
import type { BuildChat, Notice, SessionSnapshot } from "../conversation/session.js";
import { useDialogFocus } from "../hooks.js";
import { Composer } from "./Composer.js";

interface Props {
  chat: BuildChat | null;
  online: boolean;
  notice: Notice | null;
  dictation: SessionSnapshot["dictation"];
  dictated: SessionSnapshot["dictated"];
  levels: () => { input: number };
  onDictate(): void;
  onDictationStop(send: boolean): void;
  onDictationCancel(): void;
  onRefresh(): void;
  onRequest(text: string): boolean;
  onStop(): void;
  onClose(): void;
  /** Shown inside the wide layout's main panel instead of covering the screen. */
  embedded?: boolean;
}

const REFRESH_MS = 2500;

const publishSteps: Record<string, string> = {
  verify: "verificando",
  prepare: "preparando",
  apply: "aplicando el cambio",
  checks: "chequeo completo",
  commit: "creando el commit",
  push: "subiendo a GitHub",
  deploy: "desplegando",
};

/** How far the agent is, from 0 to 1: its finished steps, and the publication once it publishes. */
export function buildProgress(state: BuildChatState): number | null {
  if (state.publication?.status === "queued") return 0.9;
  if (state.publication?.status === "running") return 0.95;
  if (state.steps.length === 0) return null;
  return state.steps.filter((step) => step.status === "completed").length / state.steps.length;
}

/** One line on what is happening, in the owner's words. */
export function buildStatusLine(state: BuildChatState, now = new Date()): string | null {
  if (state.status === "offline") return "El constructor no está corriendo en el servidor: tu mensaje queda guardado y lo leo cuando arranque.";
  if (state.publication && (state.publication.status === "queued" || state.publication.status === "running")) {
    const step = state.publication.step ? publishSteps[state.publication.step] ?? state.publication.step : "en cola";
    return `Publicando: ${step}…`;
  }
  if (state.status === "waiting" && state.resumeAt) {
    const at = new Date(state.resumeAt);
    const time = at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
    const day = at.toDateString() === now.toDateString() ? "" : ` del ${at.toLocaleDateString("es-AR", { weekday: "long" })}`;
    return `Esperando que se renueve el plan: sigo solo a las ${time}${day}.`;
  }
  if (state.status === "working") return state.activity ?? "Trabajando…";
  return null;
}

function Progress({ state, onStop }: { state: BuildChatState; onStop(): void }) {
  const line = buildStatusLine(state);
  const progress = buildProgress(state);
  if (!line && progress === null) return null;
  const busy = state.status === "working" || state.publication?.status === "queued" || state.publication?.status === "running";
  return (
    <div className="build-progress" data-status={state.status}>
      {progress !== null && busy && (
        <div className="build-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div className="build-bar-fill" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
        </div>
      )}
      <div className="build-progress-line">
        {line && <p>{line}</p>}
        {state.status === "working" && (
          <button type="button" className="build-stop" onClick={onStop}>
            Frenar
          </button>
        )}
      </div>
      {busy && state.steps.length > 0 && (
        <ol className="build-steps">
          {state.steps.map((step, index) => (
            <li key={index} data-status={step.status}>
              {step.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Construir: a conversation with the agent that changes JARVIS. It answers questions, builds what
 * the owner asks, has it reviewed and publishes it on its own; the bar shows its steps.
 */
export function BuildScreen(props: Props) {
  const { chat, online, notice, dictation, dictated, levels, onDictate, onDictationStop, onDictationCancel, onRefresh, onRequest, onStop, onClose, embedded } = props;
  const list = useRef<HTMLOListElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, !embedded);
  const messages = chat?.messages ?? [];

  useEffect(() => {
    onRefresh();
    const timer = setInterval(onRefresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [onRefresh]);

  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <section ref={dialog} className={`build${embedded ? " build-embedded" : ""}`} {...(embedded ? {} : { role: "dialog", "aria-modal": true, tabIndex: -1 })} aria-labelledby="build-title">
      <header className="build-header">
        <div>
          <h2 id="build-title">Construir</h2>
          <p>Hablale como a Claude Code: pregunta, construye, revisa y publica solo</p>
        </div>
        {!embedded && (
          <button type="button" className="build-done" onClick={onClose}>
            Listo
          </button>
        )}
      </header>

      <div className="build-list">
        {chat === null && <p className="build-empty">{online ? "Cargando…" : "Sin conexión con el servidor. Reintento solo en cuanto vuelva."}</p>}
        {chat !== null && messages.length === 0 && (
          <p className="build-empty">Contame qué querés que cambie en mí o preguntame cómo funciona algo. Lo construyo, lo reviso con otro agente y lo publico sin pedirte nada.</p>
        )}
        <ol className="build-thread" ref={list}>
          {messages.map((message) =>
            message.role === "owner" ? (
              <li key={message.id} className="build-turn">
                <p className="build-request">{message.text}</p>
              </li>
            ) : (
              <li key={message.id} className="build-turn build-reply">
                <Markdown text={message.text} />
              </li>
            ),
          )}
        </ol>
      </div>

      <div className="build-composer">
        {chat && <Progress state={chat.state} onStop={onStop} />}
        {notice && (
          <p className={`build-notice build-notice-${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        )}
        <Composer
          online={online}
          busy={false}
          dictation={dictation}
          dictated={dictated}
          levels={levels}
          onSend={(value) => onRequest(value)}
          onDictate={onDictate}
          onDictationStop={onDictationStop}
          onDictationCancel={onDictationCancel}
          onStop={() => {}}
          placeholder={chat?.state.status === "working" ? "Escribí: lo leo cuando termine este paso" : "¿Qué construimos?"}
        />
      </div>
    </section>
  );
}
