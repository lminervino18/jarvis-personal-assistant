import { useEffect, useState, type FormEvent } from "react";
import type { CardActions } from "../cards/actions.js";
import { CardView } from "../cards/Cards.js";
import type { BuildTask, Notice } from "../conversation/session.js";

interface Props {
  tasks: BuildTask[] | null;
  online: boolean;
  notice: Notice | null;
  actions: CardActions;
  onRefresh(): void;
  onRequest(text: string): boolean;
  onReply(taskId: string, text: string): boolean;
  onClose(): void;
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
export function BuildScreen({ tasks, online, notice, actions, onRefresh, onRequest, onReply, onClose }: Props) {
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<BuildTask | null>(null);

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const sent = replyTo ? onReply(replyTo.taskId, text) : onRequest(text);
    if (!sent) return;
    setText("");
    setReplyTo(null);
  };

  return (
    <section className="build" role="dialog" aria-modal="true" aria-labelledby="build-title">
      <header className="build-header">
        <div>
          <h2 id="build-title">Construir</h2>
          <p>Cambios a JARVIS, revisados antes de publicar</p>
        </div>
        <button type="button" className="build-done" onClick={onClose}>
          Listo
        </button>
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
        {tasks?.map((task) => (
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

      <form className="build-composer" onSubmit={submit}>
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
        <div className="build-field field glass">
          <textarea
            value={text}
            rows={2}
            maxLength={4000}
            aria-label={replyTo ? "Respuesta para la tarea" : "Pedido de construcción"}
            placeholder={replyTo ? "Tu respuesta o los cambios que querés" : "¿Qué querés que construya?"}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="round-button" aria-label="Enviar" disabled={!online || !text.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <path fill="currentColor" d="M12 4 5 11l1.4 1.4L11 7.8V20h2V7.8l4.6 4.6L19 11z" />
            </svg>
          </button>
        </div>
      </form>
    </section>
  );
}
