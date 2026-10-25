import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface Props {
  online: boolean;
  micOpen: boolean;
  busy: boolean;
  onSend(text: string): boolean;
  onMicrophone(): void;
  onStop(): void;
}

export function Composer({ online, micOpen, busy, onSend, onMicrophone, onStop }: Props) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim()) return;
    if (onSend(text)) {
      setText("");
      field.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="message">
        Mensaje
      </label>
      <textarea
        id="message"
        ref={field}
        rows={1}
        value={text}
        placeholder="Escribile a J.A.R.V.IS"
        enterKeyHint="send"
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy && (
        <button type="button" className="button stop" onClick={onStop} aria-label="Detener">
          Detener
        </button>
      )}
      <button type="button" className="button icon" aria-pressed={micOpen} aria-label={micOpen ? "Dejar de escuchar" : "Hablar"} onClick={onMicrophone} disabled={!online}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
          <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
        </svg>
      </button>
      <button type="submit" className="button primary" disabled={!text.trim() || !online}>
        Enviar
      </button>
    </form>
  );
}
