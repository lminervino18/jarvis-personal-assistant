import { useEffect, type RefObject } from "react";
import { uploadChatAttachment } from "../attachments/upload.js";
import type { Session, SessionSnapshot } from "../conversation/session.js";
import { useFreshStart } from "../hooks.js";
import { playWelcome } from "../welcome.js";
import { Composer } from "./Composer.js";
import { Thread } from "./Thread.js";

/** The audio-blocked banner and the latest notice, wherever the owner is looking. */
export function Notices({ session, snapshot }: { session: Session; snapshot: SessionSnapshot }) {
  const { notice } = snapshot;
  return (
    <>
      {snapshot.audioBlocked && (
        <div className="banner glass" role="status">
          <span>El navegador bloqueó el audio.</span>
          <button type="button" className="button primary" onClick={() => void session.enableAudio()}>
            Activar audio
          </button>
        </div>
      )}
      {notice && (
        <div className={`banner glass banner-${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button type="button" className="button quiet" onClick={() => session.dismissNotice()}>
            Cerrar
          </button>
        </div>
      )}
    </>
  );
}

interface Props {
  session: Session;
  snapshot: SessionSnapshot;
  dock: RefObject<HTMLDivElement | null>;
  hidden?: boolean;
  demo?: boolean;
  onCall?(): void;
  /** False while Construir or Configuración covers the chat. */
  active?: boolean;
  onTransfer?(files: File[]): void;
  onOpenTransfers?(): void;
}

/** The written session: the thread, its notices and the composer. */
export function ChatView({ session, snapshot, dock, hidden, demo, onCall, active = true, onTransfer, onOpenTransfers }: Props) {
  const online = snapshot.connection === "ready";
  const { thread } = snapshot;
  const fresh = useFreshStart(snapshot.callActive || snapshot.busy);
  useEffect(() => {
    if (fresh.since !== null) void playWelcome();
  }, [fresh.since]);
  const since = fresh.since;
  const earlier = since === null ? 0 : thread.messages.filter((message) => Date.parse(message.at) <= since).length;
  const empty = thread.messages.length === earlier && !thread.transcript && (earlier > 0 || !thread.hasMore);

  return (
    <div className="chat" hidden={hidden} inert={!active}>
      <Thread
        thread={thread}
        actions={session}
        activity={session.activity}
        since={since}
        earlier={earlier}
        onReveal={fresh.reveal}
        onLoadOlder={() => session.loadOlder()}
        placeholder={
          empty && (
            <section className="chat-empty" aria-label="Inicio">
              <h2>{snapshot.ownerName ? `Hola, ${snapshot.ownerName}` : "Hola"}</h2>
              <p>Escribime, dictame o llamame.</p>
              {earlier > 0 && (
                <button type="button" className="button chat-earlier" onClick={fresh.reveal}>
                  Ver conversación anterior
                </button>
              )}
            </section>
          )
        }
      />
      <div className="dock" ref={dock}>
        <Notices session={session} snapshot={snapshot} />
        <Composer
          online={online}
          busy={snapshot.busy && !snapshot.callActive}
          dictation={snapshot.dictation}
          dictated={snapshot.dictated}
          levels={session.getLevels}
          onSend={(text, attachments) => session.sendText(text, attachments)}
          onDictate={() => void session.startDictation()}
          onDictationStop={(send) => session.stopDictation(send)}
          onDictationCancel={() => session.cancelDictation()}
          onStop={() => session.stopAll()}
          onCall={snapshot.callActive ? undefined : onCall}
          active={active}
          onAttach={demo ? undefined : uploadChatAttachment}
          onFocus={() => session.warm()}
          onTransfer={onTransfer}
          onOpenTransfers={onOpenTransfers}
        />
      </div>
    </div>
  );
}
