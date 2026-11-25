import { useEffect, useState } from "react";
import type { CardActions } from "../cards/actions.js";
import { CardView } from "../cards/Cards.js";
import type { BuildTask, Notice, SessionSnapshot } from "../conversation/session.js";
import { Composer } from "./Composer.js";

interface Props {
  tasks: BuildTask[] | null;
  online: boolean;
  notice: Notice | null;
  actions: CardActions;
  dictation: SessionSnapshot["dictation"];
  dictated: SessionSnapshot["dictated"];
  levels: () => { input: number };
  onDictate(): void;
  onDictationStop(send: boolean): void;
  onDictationCancel(): void;
  onRefresh(): void;
  onRequest(text: string): boolean;
  onReply(taskId: string, text: string): boolean;
  onClose(): void;
  /** Shown inside the wide layout's main panel instead of covering the screen. */
  embedded?: boolean;
}

const REFRESH_MS = 4000;

function replyLabel(task: BuildTask): string {
  if (task.status === "accepted") return "Pedir otro cambio";
  if (task.status === "awaiting_owner") return "Responder";
  return "Pedir cambios";
}

/**
 * Build mode: changes to JARVIS itself. Each request becomes a task an agent programs and
 * another one reviews; the owner answers questions here and decides whether to publish.
 */
export function BuildScreen(props: Props) {
  const { tasks, online, notice, actions, dictation, dictated, levels, onDictate, onDictationStop, onDictationCancel, onRefresh, onRequest, onReply, onClose, embedded } = props;
  const [replyTo, setReplyTo] = useState<BuildTask | null>(null);

  const send = (value: string): boolean => {
    const sent = replyTo ? onReply(replyTo.taskId, value) : onRequest(value);
    if (!sent) return false;
    setReplyTo(null);
    return true;
  };

  useEffect(() => {
    onRefresh();
    const timer = setInterval(onRefresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [onRefresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  return (
    <section className={`build${embedded ? " build-embedded" : ""}`} {...(embedded ? {} : { role: "dialog", "aria-modal": true })} aria-labelledby="build-title">
      <header className="build-header">
        <div>
          <h2 id="build-title">Construir</h2>
          <p>Cambios a JARVIS, revisados antes de publicar</p>
        </div>
        {!embedded && (
          <button type="button" className="build-done" onClick={onClose}>
            Listo
          </button>
        )}
      </header>

      <div className="build-list">
        {tasks === null && <p className="build-empty">Cargando…</p>}
        {tasks?.length === 0 && (
          <div className="build-empty">
            <p>Pedime un cambio sobre mí mismo: una herramienta, un ajuste de la pantalla, un modo nuevo.</p>
            <ol>
              <li>Un agente lo programa en una copia y corre los tests.</li>
              <li>Otro agente lo revisa por su cuenta.</li>
              <li>Vos ves el resultado y decidís si se publica.</li>
            </ol>
          </div>
        )}
        {tasks?.filter((task) => !task.archived).map((task) => (
          <div key={task.taskId} className="build-item">
            <CardView card={task} actions={actions} />
            {task.status !== "cancelled" && (
              <button type="button" className="build-reply" onClick={() => setReplyTo(task)}>
                {replyLabel(task)}
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="build-composer">
        {notice && (
          <p className={`build-notice build-notice-${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        )}
        {replyTo && (
          <p className="build-target">
            <span>
              {replyTo.status === "accepted" ? "Nuevo cambio a partir de" : "Respondiendo a"} la tarea #{replyTo.ref}
            </span>
            <button type="button" aria-label="Volver a un pedido nuevo" onClick={() => setReplyTo(null)}>
              ×
            </button>
          </p>
        )}
        <Composer
          online={online}
          busy={false}
          dictation={dictation}
          dictated={dictated}
          levels={levels}
          onSend={(value) => send(value)}
          onDictate={onDictate}
          onDictationStop={onDictationStop}
          onDictationCancel={onDictationCancel}
          onStop={() => {}}
          placeholder={replyTo ? "Tu respuesta o los cambios que querés" : "¿Qué querés que construya?"}
        />
      </div>
    </section>
  );
}
