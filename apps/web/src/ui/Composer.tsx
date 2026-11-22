import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { attachmentLine, type UploadOutcome } from "../tasks/attachments.js";

interface Props {
  online: boolean;
  busy: boolean;
  recording: boolean;
  onSend(text: string): boolean;
  onNoteStart(): void;
  onNoteEnd(send: boolean): void;
  onStop(): void;
  /** Starts the voice call; without it the round button only sends. */
  onCall?(): void;
  onAttach?(file: File): Promise<UploadOutcome>;
}

const MAX_FIELD_PX = 140;
const MIN_NOTE_MS = 400;

function useRecordingClock(recording: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!recording) return setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Composer({ online, busy, recording, onSend, onNoteStart, onNoteEnd, onStop, onCall, onAttach }: Props) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pressedAt = useRef(0);
  const clock = useRecordingClock(recording);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_FIELD_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 3500);
    return () => clearTimeout(timer);
  }, [hint]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim()) return;
    if (onSend(text)) setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!onAttach || files.length === 0) return;
    setUploading(true);
    for (const file of files) {
      const outcome = await onAttach(file);
      if (!outcome.ok) {
        setHint(outcome.message);
        break;
      }
      setText((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${attachmentLine(outcome.id, outcome.name)}\n`);
    }
    setUploading(false);
  };

  const onPressNote = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedAt.current = Date.now();
    onNoteStart();
  };

  const onReleaseNote = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const held = Date.now() - pressedAt.current;
    const box = event.currentTarget.getBoundingClientRect();
    const inside = event.clientX >= box.left - 40 && event.clientX <= box.right + 40 && event.clientY >= box.top - 60;
    if (held < MIN_NOTE_MS) setHint("Mantené apretado el micrófono para grabar un audio.");
    onNoteEnd(held >= MIN_NOTE_MS && inside);
  };

  const hasText = text.trim().length > 0;

  return (
    <form className="composer" data-recording={recording} onSubmit={submit}>
      {hint && (
        <p className="composer-hint glass" role="status">
          {hint}
        </p>
      )}
      {onAttach && !recording && (
        <>
          <input ref={picker} type="file" multiple hidden onChange={(event) => void onFiles(event)} />
          <button type="button" className="glass-button glass" aria-label={uploading ? "Subiendo archivo" : "Adjuntar archivo o captura"} disabled={!online || uploading} onClick={() => picker.current?.click()}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" />
            </svg>
          </button>
        </>
      )}
      <div className="field glass">
        {recording ? (
          <p className="recording" role="status">
            <span className="recording-dot" aria-hidden="true" />
            {clock} · soltá para enviar, deslizá para cancelar
          </p>
        ) : (
          <>
            <label className="sr-only" htmlFor="message">
              Mensaje
            </label>
            <textarea
              id="message"
              ref={field}
              rows={1}
              value={text}
              placeholder="Mensaje"
              enterKeyHint="send"
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </>
        )}
        {!hasText && (
          <button
            type="button"
            className="field-button note"
            aria-label="Mantené apretado para grabar un audio"
            aria-pressed={recording}
            disabled={!online}
            onPointerDown={onPressNote}
            onPointerUp={onReleaseNote}
            onPointerCancel={() => onNoteEnd(false)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
            </svg>
          </button>
        )}
      </div>
      {busy && !hasText && !recording ? (
        <button type="button" className="round-button stop" onClick={onStop} aria-label="Detener">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
            <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
          </svg>
        </button>
      ) : hasText ? (
        <button type="submit" className="round-button" aria-label="Enviar" disabled={!online}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
            <path fill="currentColor" d="M11 20V7.83l-5.59 5.59L4 12l8-8 8 8-1.41 1.41L13 7.83V20h-2Z" />
          </svg>
        </button>
      ) : (
        onCall &&
        !recording && (
          <button type="button" className="round-button voice" aria-label="Hablar con Jarvis" onClick={onCall}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M7 9h2v6H7V9Zm4-4h2v14h-2V5Zm4 2h2v10h-2V7ZM3 11h2v2H3v-2Zm16 0h2v2h-2v-2Z" />
            </svg>
          </button>
        )
      )}
    </form>
  );
}
