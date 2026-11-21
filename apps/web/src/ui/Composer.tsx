import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { attachmentLine, type UploadOutcome } from "../tasks/attachments.js";

interface Props {
  online: boolean;
  micOpen: boolean;
  busy: boolean;
  onSend(text: string): boolean;
  onMicrophone(): void;
  onStop(): void;
  onAttach?(file: File): Promise<UploadOutcome>;
}

export function Composer({ online, micOpen, busy, onSend, onMicrophone, onStop, onAttach }: Props) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

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

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!onAttach || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    for (const file of files) {
      const outcome = await onAttach(file);
      if (!outcome.ok) {
        setUploadError(outcome.message);
        break;
      }
      setText((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}${attachmentLine(outcome.id, outcome.name)}\n`);
    }
    setUploading(false);
    field.current?.focus();
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="message">
        Mensaje
      </label>
      {uploadError && (
        <p className="composer-error" role="status">
          {uploadError}
        </p>
      )}
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
      {onAttach && (
        <>
          <input ref={picker} type="file" multiple hidden onChange={(event) => void onFiles(event)} />
          <button type="button" className="button icon" aria-label={uploading ? "Subiendo archivo" : "Adjuntar archivo o captura"} disabled={!online || uploading} onClick={() => picker.current?.click()}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6.5H9v9a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10h-1.5Z" />
            </svg>
          </button>
        </>
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
