import type { RefObject } from "react";
import { uploadChatAttachment } from "../attachments/upload.js";
import type { Session, SessionSnapshot } from "../conversation/session.js";
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
}

/** The written session: the thread, its notices and the composer. */
export function ChatView({ session, snapshot, dock, hidden, demo }: Props) {
  const online = snapshot.connection === "ready";
  const { thread } = snapshot;
  const empty = thread.messages.length === 0 && !thread.hasMore && !thread.transcript;

  return (
    <div className="chat" hidden={hidden}>
      <Thread thread={thread} actions={session} onLoadOlder={() => session.loadOlder()} />
      {empty && (
        <section className="chat-empty" aria-label="Inicio">
          <h2>{snapshot.ownerName ? `Hola, ${snapshot.ownerName}` : "Hola"}</h2>
          <p>Escribime, dictame o mandame un audio.</p>
        </section>
      )}
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
          onAttach={demo ? undefined : uploadChatAttachment}
          onFocus={() => session.warm()}
        />
      </div>
    </div>
  );
}
