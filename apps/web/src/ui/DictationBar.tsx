import { useEffect, useRef, useState } from "react";

interface Props {
  state: "recording" | "transcribing";
  levels: () => { input: number };
  onStop(): void;
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

function Waveform({ levels }: { levels: () => { input: number } }) {
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

/** The composer while dictating: cancel on the left, the live waveform, and "done" on the right. */
export function DictationBar({ state, levels, onStop, onCancel }: Props) {
  const seconds = useRecordingSeconds(state === "recording");
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <>
      <button type="button" className="glass-button glass" aria-label="Cancelar dictado" onClick={onCancel}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
          <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
        </svg>
      </button>
      <div className="field glass dictation" role="status" aria-live="polite">
        {state === "recording" ? (
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
      </div>
      <button type="button" className="round-button dictation-done" aria-label="Listo: escribir lo que dije" disabled={state !== "recording"} onClick={onStop}>
        <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
          <path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z" />
        </svg>
      </button>
    </>
  );
}
