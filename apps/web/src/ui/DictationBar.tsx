import { useEffect, useRef, useState } from "react";

interface Props {
  state: "recording" | "transcribing";
  levels: () => { input: number };
  /** Finishes recording; `send` sends the transcript instead of writing it into the field. */
  onStop(send: boolean): void;
  onCancel(): void;
}

const BARS = 40;
const SAMPLE_MS = 70;

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

export function Waveform({ levels }: { levels: () => { input: number } }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const history: number[] = new Array<number>(BARS).fill(0);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= SAMPLE_MS) {
        last = now;
        history.shift();
        history.push(levels().input);
        history.forEach((value, index) => {
          const bar = bars.current[index];
          if (bar) bar.style.transform = `scaleY(${0.12 + Math.min(1, value) * 0.88})`;
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels]);

  return (
    <span className="waveform" aria-hidden="true">
      {Array.from({ length: BARS }, (_, index) => (
        <span key={index} ref={(element) => void (bars.current[index] = element)} />
      ))}
    </span>
  );
}

/**
 * The composer while dictating: cancel, the live waveform, then the two ways to finish: write the
 * transcript into the field to keep editing, or send it as soon as it is transcribed.
 */
export function DictationBar({ state, levels, onStop, onCancel }: Props) {
  const seconds = useRecordingSeconds(state === "recording");
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const recording = state === "recording";

  return (
    <>
      <button type="button" className="glass-button glass" aria-label="Cancelar dictado" onClick={onCancel}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
          <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
        </svg>
      </button>
      <div className="field glass dictation" role="status" aria-live="polite">
        {recording ? (
          <>
            <span className="sr-only">Escuchando</span>
            <Waveform levels={levels} />
            <span className="dictation-clock">{clock}</span>
          </>
        ) : (
          <span className="dictation-busy">
            <span className="spinner" aria-hidden="true" />
            Transcribiendo…
          </span>
        )}
        <button type="button" className="field-button dictation-write" aria-label="Escribir lo que dije para editarlo" disabled={!recording} onClick={() => onStop(false)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
            <path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.33-2.33a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.82-1.84Z" />
          </svg>
        </button>
      </div>
      <button type="button" className="round-button" aria-label="Enviar lo que dije" disabled={!recording} onClick={() => onStop(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
          <path fill="currentColor" d="M11 20V7.83l-5.59 5.59L4 12l8-8 8 8-1.41 1.41L13 7.83V20h-2Z" />
        </svg>
      </button>
    </>
  );
}
