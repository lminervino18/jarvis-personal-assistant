import { useMemo, useRef, useState } from "react";
import type { CardActions } from "../cards/actions.js";
import type { ThreadState } from "../conversation/thread.js";
import { threadView } from "../conversation/thread.js";
import { useStickToBottom } from "../hooks.js";
import { shouldShowInstallHint, readPlatform } from "../pwa/platform.js";
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
        <p>Para usar J.A.R.V.I.S. como app y recibir avisos: tocá Compartir y elegí Agregar a inicio.</p>
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
  onLoadOlder(): void;
}

export function Thread({ thread, actions, onLoadOlder }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => threadView(thread.messages), [thread.messages]);
  useStickToBottom(scroller, messages);

  return (
    <div className="thread" ref={scroller} role="region" aria-label="Conversación" tabIndex={0}>
      {thread.hasMore && (
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
    </div>
  );
}
