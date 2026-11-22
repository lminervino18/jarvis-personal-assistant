import type { AssistantState } from "@jarvis/contracts";
import { useEffect, useState } from "react";
import { Core } from "../core/Core.js";
import type { LevelReading } from "../core/core-style.js";

interface Props {
  state: AssistantState;
  label: string;
  muted: boolean;
  getLevels(): LevelReading;
  onMute(): void;
  onHangUp(): void;
}

function useElapsed(): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Full-screen voice call: no thread on screen, every reply is spoken, the conversation is still saved. */
export function CallScreen({ state, label, muted, getLevels, onMute, onHangUp }: Props) {
  const elapsed = useElapsed();
  return (
    <div className="call" role="dialog" aria-modal="true" aria-label="Llamada con Jarvis" data-state={state}>
      <header className="call-header">
        <p className="call-title">Jarvis</p>
        <p className="call-time">{elapsed}</p>
      </header>
      <div className="call-core">
        <Core state={state} label={label} getLevels={getLevels} />
      </div>
      <p className="call-state" role="status" data-state={state}>
        {muted ? "Micrófono silenciado" : label}
      </p>
      <div className="call-controls">
        <button type="button" className="call-button glass" aria-pressed={muted} aria-label={muted ? "Activar micrófono" : "Silenciar micrófono"} onClick={onMute}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="28" height="28">
            {muted ? (
              <path fill="currentColor" d="M19 11h-1.7a5.4 5.4 0 0 1-.57 2.4l1.23 1.23A7 7 0 0 0 19 11ZM15 11.16V5a3 3 0 0 0-5.94-.6L15 10.34v.82ZM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.4 2.65l1.66 1.66A5.3 5.3 0 0 1 12 16.3 5.3 5.3 0 0 1 6.7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.53-.82L19.73 21 21 19.73 4.27 3Z" />
            ) : (
              <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" />
            )}
          </svg>
        </button>
        <button type="button" className="call-button call-hangup" aria-label="Colgar" onClick={onHangUp}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="30" height="30">
            <path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.77 7.46 7 12 7s8.66 1.77 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
