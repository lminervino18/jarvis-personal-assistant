import { useEffect, useState } from "react";
import { fetchEnrollment, resetEnrollment, uploadSample, type EnrollmentState } from "../voice/enrollment-api.js";
import { Waveform } from "./DictationBar.js";
import { MicIcon } from "./icons.js";

interface Props {
  levels: () => { input: number };
  onStart(): Promise<boolean>;
  onStop(): Int16Array;
  onClose(): void;
  embedded?: boolean;
}

type Step = "idle" | "recording" | "uploading";

/** Teaches Jarvis the owner's voice: one phrase at a time, read aloud and uploaded, until every phrase is recorded. */
export function VoiceTraining({ levels, onStart, onStop, onClose, embedded }: Props) {
  const [state, setState] = useState<EnrollmentState | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [current, setCurrent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetchEnrollment().then((next) => {
      setState(next);
      if (next) setCurrent(next.phrases.findIndex((_, index) => !next.recorded.includes(index)));
    });
  }, []);

  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

  const record = async () => {
    setMessage(null);
    if (step === "idle") {
      if (await onStart()) setStep("recording");
      return;
    }
    if (step !== "recording" || !state) return;
    setStep("uploading");
    const outcome = await uploadSample(current, onStop());
    setStep("idle");
    if (typeof outcome === "string") return setMessage(outcome);
    setState(outcome);
    setCurrent(outcome.phrases.findIndex((_, index) => !outcome.recorded.includes(index)));
  };

  const redo = async () => {
    const next = await resetEnrollment();
    if (!next) return;
    setState(next);
    setCurrent(0);
  };

  const finished = state !== null && current < 0;
  const phrase = state && current >= 0 ? state.phrases[current] : undefined;

  return (
    <section className={`build voice-training${embedded ? " build-embedded" : ""}`} {...(embedded ? {} : { role: "dialog", "aria-modal": true })} aria-labelledby="voice-title">
      <header className="build-header">
        <div>
          <h2 id="voice-title">Mi voz</h2>
          <p>Leé cada frase en voz alta, con tu tono de siempre</p>
        </div>
        {!embedded && (
          <button type="button" className="build-done" onClick={onClose}>
            Listo
          </button>
        )}
      </header>

      <div className="voice-training-body">
        {!state && <p className="build-empty">Cargando…</p>}
        {state && !finished && phrase && (
          <>
            <p className="voice-training-count">
              Frase {current + 1} de {state.phrases.length}
            </p>
            <p className="voice-training-phrase">«{phrase}»</p>
            <div className="voice-training-meter" aria-hidden="true">
              {step === "recording" && <Waveform levels={levels} />}
            </div>
            <button type="button" className="voice-training-record" data-recording={step === "recording"} disabled={step === "uploading"} onClick={() => void record()}>
              <MicIcon size={34} />
            </button>
            <p className="voice-training-hint" role="status">
              {message ?? (step === "recording" ? "Tocá de nuevo cuando termines" : step === "uploading" ? "Guardando…" : "Tocá y leé la frase")}
            </p>
          </>
        )}
        {finished && (
          <>
            <p className="voice-training-phrase">Listo: ya reconozco tu voz.</p>
            <p className="voice-training-hint">En las llamadas ignoro otras voces y ruidos de fondo.</p>
            <button type="button" className="button" onClick={() => void redo()}>
              Volver a grabar
            </button>
          </>
        )}
      </div>
    </section>
  );
}
