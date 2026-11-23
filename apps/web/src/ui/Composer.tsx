import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { AttachmentCard, ChatUpload } from "../attachments/upload.js";
import { lockProgress, noteGesture } from "./note-gesture.js";

interface Props {
  online: boolean;
  busy: boolean;
  recording: boolean;
  onSend(text: string, attachments: AttachmentCard[]): boolean;
  onNoteStart(): void;
  onNoteEnd(send: boolean): void;
  onStop(): void;
  /** Starts the voice call; without it the round button only sends. */
  onCall?(): void;
  onAttach?(file: File): Promise<ChatUpload>;
  /** The owner started writing. */
  onFocus?(): void;
}

const MAX_FIELD_PX = 140;
const MIN_NOTE_MS = 400;
const MAX_NOTE_SECONDS = 120;
const MAX_ATTACHMENTS = 4;

interface Pending {
  key: string;
  name: string;
  preview?: string;
  card?: AttachmentCard;
}

function revoke(items: readonly Pending[]): void {
  for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
}

function useRecordingSeconds(recording: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!recording) return setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);
  return seconds;
}

function clockLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Composer({ online, busy, recording, onSend, onNoteStart, onNoteEnd, onStop, onCall, onAttach, onFocus }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const uploading = attachments.some((item) => !item.card);
  const [hint, setHint] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pressedAt = useRef(0);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const [locked, setLocked] = useState(false);
  const [lift, setLift] = useState(0);
  const seconds = useRecordingSeconds(recording);
  const handsFree = recording && locked;

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

  const ready = attachments.flatMap((item) => item.card ?? []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if ((!text.trim() && ready.length === 0) || uploading) return;
    if (!onSend(text, ready)) return;
    setText("");
    revoke(attachments);
    setAttachments([]);
  };

  const remove = (key: string) => {
    setAttachments((current) => {
      revoke(current.filter((item) => item.key === key));
      return current.filter((item) => item.key !== key);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, MAX_ATTACHMENTS - attachments.length);
    event.target.value = "";
    if (!onAttach || files.length === 0) return;
    const added = files.map((file) => ({ key: crypto.randomUUID(), name: file.name, ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}) }));
    setAttachments((current) => [...current, ...added]);
    await Promise.all(
      files.map(async (file, index) => {
        const key = added[index]?.key;
        const outcome = await onAttach(file);
        if (outcome.ok) {
          setAttachments((current) => current.map((item) => (item.key === key ? { ...item, card: outcome.card } : item)));
          return;
        }
        setHint(outcome.message);
        if (key) remove(key);
      }),
    );
  };

  const finishNote = (send: boolean) => {
    pressStart.current = null;
    setLocked(false);
    setLift(0);
    onNoteEnd(send);
  };

  useEffect(() => {
    if (handsFree && seconds >= MAX_NOTE_SECONDS) finishNote(true);
  });

  const onPressNote = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedAt.current = Date.now();
    pressStart.current = { x: event.clientX, y: event.clientY };
    setLocked(false);
    setLift(0);
    onNoteStart();
  };

  const onMoveNote = (event: PointerEvent<HTMLButtonElement>) => {
    const start = pressStart.current;
    if (!start) return;
    const now = { x: event.clientX, y: event.clientY };
    const gesture = noteGesture(start, now);
    if (gesture === "cancel") return finishNote(false);
    if (gesture === "lock") {
      pressStart.current = null;
      setLift(0);
      setLocked(true);
      return;
    }
    setLift(lockProgress(start, now));
  };

  const onReleaseNote = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!pressStart.current) return;
    const held = Date.now() - pressedAt.current;
    if (held < MIN_NOTE_MS) setHint("Mantené apretado el micrófono para grabar, o deslizalo hacia arriba para dejarlo fijo.");
    finishNote(held >= MIN_NOTE_MS);
  };

  const hasText = text.trim().length > 0 || ready.length > 0;

  return (
    <form className="composer" data-recording={recording} onSubmit={submit}>
      {attachments.length > 0 && !recording && (
        <ul className="composer-attachments" aria-label="Adjuntos">
          {attachments.map((item) => (
            <li key={item.key} className="composer-attachment glass" data-uploading={!item.card}>
              {item.preview ? <img src={item.preview} alt="" /> : <span className="composer-file">{item.name.split(".").pop()?.toUpperCase().slice(0, 4) ?? "DOC"}</span>}
              <span className="sr-only">{item.card ? item.name : `Subiendo ${item.name}`}</span>
              <button type="button" aria-label={`Quitar ${item.name}`} onClick={() => remove(item.key)}>
                <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14">
                  <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hint && (
        <p className="composer-hint glass" role="status">
          {hint}
        </p>
      )}
      {onAttach && !recording && (
        <>
          <input ref={picker} type="file" multiple hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv" onChange={(event) => void onFiles(event)} />
          <button
            type="button"
            className="glass-button glass"
            aria-label="Adjuntar foto o archivo"
            disabled={!online || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => picker.current?.click()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" />
            </svg>
          </button>
        </>
      )}
      <div className="field glass">
        {handsFree && (
          <button type="button" className="field-button discard" aria-label="Descartar audio" onClick={() => finishNote(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
            </svg>
          </button>
        )}
        {recording ? (
          <p className="recording" role="status">
            <span className="recording-dot" aria-hidden="true" />
            {clockLabel(seconds)}
            <span className="recording-hint">{handsFree ? "Grabando" : "↑ fijar · ← cancelar"}</span>
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
              onFocus={onFocus}
            />
          </>
        )}
        {!hasText && !handsFree && (
          <span className="note-wrap">
            {recording && (
              <span className="note-lock" style={{ "--lift": lift } as CSSProperties} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z" />
                </svg>
                <svg viewBox="0 0 24 24" width="14" height="14">
                  <path fill="currentColor" d="m12 7 6 6-1.41 1.41L12 9.83l-4.59 4.58L6 13l6-6Z" />
                </svg>
              </span>
            )}
            <button
              type="button"
              className="field-button note"
              aria-label="Grabar audio: mantené apretado, deslizá hacia arriba para dejarlo fijo"
              aria-pressed={recording}
              disabled={!online}
              onPointerDown={onPressNote}
              onPointerMove={onMoveNote}
              onPointerUp={onReleaseNote}
              onPointerCancel={() => pressStart.current && finishNote(false)}
              onContextMenu={(event) => event.preventDefault()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
              </svg>
            </button>
          </span>
        )}
      </div>
      {handsFree ? (
        <button type="button" className="round-button" aria-label="Enviar audio" onClick={() => finishNote(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
            <path fill="currentColor" d="M11 20V7.83l-5.59 5.59L4 12l8-8 8 8-1.41 1.41L13 7.83V20h-2Z" />
          </svg>
        </button>
      ) : busy && !hasText && !recording ? (
        <button type="button" className="round-button stop" onClick={onStop} aria-label="Detener">
          <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
            <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
          </svg>
        </button>
      ) : hasText ? (
        <button type="submit" className="round-button" aria-label="Enviar" disabled={!online || uploading}>
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
