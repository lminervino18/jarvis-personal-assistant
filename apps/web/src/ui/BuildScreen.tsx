import { useEffect, useRef, useState } from "react";
import type { CardActions } from "../cards/actions.js";
import { taskActionsFor } from "../cards/Cards.js";
import type { BuildTask, Notice, SessionSnapshot } from "../conversation/session.js";
import { safeHref } from "../format.js";
import { useDialogFocus } from "../hooks.js";
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

const phaseLines = { plan: "Pensando cómo hacerlo…", execute: "Programando…", review: "Revisándolo con otro agente…" } as const;

const publishSteps: Record<string, string> = {
  verify: "verificando",
  prepare: "preparando",
  apply: "aplicando el cambio",
  checks: "chequeo completo",
  commit: "creando el commit",
  push: "subiendo a GitHub",
  deploy: "desplegando",
};

/** Where a change to JARVIS is, in one sentence. */
export function buildLine(task: BuildTask): string {
  if (task.paused && (task.status === "queued" || task.status === "running")) return "En pausa.";
  const publication = task.publication;
  switch (task.status) {
    case "queued":
    case "running":
      return `${task.phase ? phaseLines[task.phase] : "En cola…"}${task.iteration > 1 ? ` (vuelta ${task.iteration})` : ""}`;
    case "awaiting_owner":
      return task.blocker?.kind === "question" ? `Necesito que me respondas: ${task.blocker.message}` : (task.blocker?.message ?? "Estoy esperando algo de vos.");
    case "ready":
      return "Revisado y aprobado: lo publico ahora.";
    case "accepted":
      if (!publication || publication.status === "queued") return "Revisado y aprobado: lo publico ahora.";
      if (publication.status === "running") return `Publicando${publication.step ? `: ${publishSteps[publication.step] ?? publication.step}` : ""}…`;
      if (publication.status === "published") return `Listo, ya está en producción${publication.commit ? ` (commit ${publication.commit.slice(0, 7)})` : ""}.`;
      return `No se pudo publicar${publication.message ? `: ${publication.message}` : "."}`;
    case "failed":
      return `No pude terminarlo${task.blocker?.message ? `: ${task.blocker.message}` : "."}`;
    case "cancelled":
      return "Cancelado.";
  }
}

/**
 * Construir: changes to JARVIS itself, as a conversation. Each request is programmed by an agent,
 * reviewed by another and published on its own; Jarvis only asks when something is unclear.
 */
export function BuildScreen(props: Props) {
  const { tasks, online, notice, actions, dictation, dictated, levels, onDictate, onDictationStop, onDictationCancel, onRefresh, onRequest, onReply, onClose, embedded } = props;
  const list = useRef<HTMLOListElement>(null);
  const [sent, setSent] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, !embedded);
  const visible = (tasks ?? []).filter((task) => !task.archived).reverse();
  const asking = [...visible].reverse().find((task) => task.status === "awaiting_owner" && task.blocker?.kind === "question");

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
  }, [visible.length]);

  const send = (value: string): boolean => (asking ? onReply(asking.taskId, value) : onRequest(value));

  return (
    <section ref={dialog} className={`build${embedded ? " build-embedded" : ""}`} {...(embedded ? {} : { role: "dialog", "aria-modal": true, tabIndex: -1 })} aria-labelledby="build-title">
      <header className="build-header">
        <div>
          <h2 id="build-title">Construir</h2>
          <p>Pedile cambios a Jarvis: los programa, los revisa y los publica solo</p>
        </div>
        {!embedded && (
          <button type="button" className="build-done" onClick={onClose}>
            Listo
          </button>
        )}
      </header>

      <div className="build-list">
        {tasks === null && <p className="build-empty">{online ? "Cargando…" : "Sin conexión con el servidor. Reintento solo en cuanto vuelva."}</p>}
        {tasks !== null && visible.length === 0 && (
          <p className="build-empty">Contame qué querés que cambie en mí: una herramienta, algo de la pantalla, un modo nuevo. Si algo no me queda claro, te pregunto.</p>
        )}
        <ol className="build-thread" ref={list}>
          {visible.map((task) => {
            const url = safeHref(task.publication?.url);
            return (
              <li key={task.taskId} className="build-turn">
                <p className="build-request">{task.title}</p>
                <div className="build-answer" data-status={task.publication?.status ?? task.status}>
                  <p>{buildLine(task)}</p>
                  {task.summary && <p className="build-summary">{task.summary}</p>}
                  <p className="build-links">
                    #{task.ref}
                    {task.iteration > 0 && (
                      <>
                        {" · "}
                        <a href={`/api/tasks/${task.ref}/diff`} target="_blank" rel="noopener noreferrer">
                          ver cambios
                        </a>
                      </>
                    )}
                    {url && (
                      <>
                        {" · "}
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          abrir
                        </a>
                      </>
                    )}
                  </p>
                  {sent !== `${task.taskId}:${task.updatedAt}` &&
                    taskActionsFor(task).map((button) => (
                      <button
                        key={button.action}
                        type="button"
                        className="build-action"
                        onClick={() => {
                          setSent(`${task.taskId}:${task.updatedAt}`);
                          actions.taskAction(task.taskId, button.action, button.action === "approve" || button.action === "reject" ? task.blocker?.approvalId : undefined);
                        }}
                      >
                        {button.label}
                      </button>
                    ))}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="build-composer">
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
          onSend={(value) => send(value)}
          onDictate={onDictate}
          onDictationStop={onDictationStop}
          onDictationCancel={onDictationCancel}
          onStop={() => {}}
          placeholder={asking ? `Respondé a la tarea #${asking.ref}` : "¿Qué querés que construya?"}
        />
      </div>
    </section>
  );
}
