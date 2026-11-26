import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CardActions } from "../cards/actions.js";
import type { ThreadState } from "../conversation/thread.js";
import { threadView } from "../conversation/thread.js";
import { useStickToBottom } from "../hooks.js";
import { shouldShowInstallHint, readPlatform } from "../pwa/platform.js";
import { ArrowDownIcon } from "./icons.js";
import { MessageView } from "./MessageView.js";

const HINT_KEY = "jarvis.installHintDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function InstallHint() {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!shouldShowInstallHint(readPlatform(), dismissed)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      return;
    }
  };
  return (
    <li className="message message-system">
      <section className="card" aria-label="Instalar en el iPhone">
        <p className="card-kicker">Instalar</p>
        <p>Para usar Jarvis como app y recibir notificaciones: tocá Compartir y elegí «Agregar a inicio».</p>
        <div className="card-actions">
          <button type="button" className="button" onClick={dismiss}>
            Entendido
          </button>
        </div>
      </section>
    </li>
  );
}

interface Props {
  thread: ThreadState;
  actions: CardActions;
  /** Only messages after this moment are shown until the owner reveals the rest; null shows all. */
  since: number | null;
  /** How many messages are kept behind «Ver conversación anterior». */
  earlier: number;
  onReveal(): void;
  onLoadOlder(): void;
  /** Shown in the free space when there is nothing to read yet, like the greeting. */
  placeholder?: ReactNode;
}

export function Thread({ thread, actions, since, earlier, onReveal, onLoadOlder, placeholder }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const all = useMemo(() => threadView(thread.messages), [thread.messages]);
  const messages = useMemo(() => (since === null ? all : all.filter((message) => Date.parse(message.at) > since)), [all, since]);
  const stick = useStickToBottom(scroller, content);
  const first = messages[0]?.id;
  const last = messages.at(-1);
  const ownLast = last?.role === "user" ? last.id : undefined;

  useLayoutEffect(() => {
    if (ownLast) stick.toEnd();
  }, [ownLast]);
  useLayoutEffect(() => {
    stick.keepPosition();
  }, [first]);

  return (
    <>
      <div className="thread" ref={scroller} role="region" aria-label="Conversación" tabIndex={0}>
        <div ref={content} className="thread-content">
          {earlier > 0 && messages.length > 0 && (
            <button type="button" className="button older" onClick={onReveal}>
              Ver conversación anterior
            </button>
          )}
          {earlier === 0 && thread.hasMore && (
            <button type="button" className="button older" disabled={thread.loadingOlder} onClick={onLoadOlder}>
              {thread.loadingOlder ? "Cargando" : "Ver mensajes anteriores"}
            </button>
          )}
          <ol className="messages">
            <InstallHint />
            {messages.map((message) => (
              <MessageView key={message.id} message={message} actions={actions} />
            ))}
          </ol>
          {thread.transcript && (
            <p className="transcript" data-final={thread.transcript.final}>
              <span className="sr-only">Estás diciendo: </span>
              {thread.transcript.text}
            </p>
          )}
          {placeholder}
        </div>
      </div>
      {stick.away && (
        <button type="button" className="glass-button glass jump-latest" aria-label="Ir al último mensaje" onClick={() => stick.toEnd(true)}>
          <ArrowDownIcon />
        </button>
      )}
    </>
  );
}
