import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogFocus } from "../hooks.js";
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

type Step = "idle" | "starting" | "recording" | "uploading";

/** Teaches Jarvis the owner's voice: one phrase at a time, read aloud and uploaded, until every phrase is recorded. */
export function VoiceTraining({ levels, onStart, onStop, onClose, embedded }: Props) {
  const [state, setState] = useState<EnrollmentState | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [current, setCurrent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, !embedded);

  const load = useCallback(() => {
    setFailed(false);
    void fetchEnrollment().then((next) => {
      if (!next) return setFailed(true);
      setState(next);
      setCurrent(next.phrases.findIndex((_, index) => !next.recorded.includes(index)));
    });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

  const record = async () => {
    setMessage(null);
    if (step === "idle") {
      setStep("starting");
      const started = await onStart();
      setStep(started ? "recording" : "idle");
      if (!started) setMessage("No pude usar el micrófono. Revisá el permiso del navegador y probá de nuevo.");
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
    setMessage(null);
    const next = await resetEnrollment();
    if (!next) return setMessage("No pude borrar las grabaciones. Probá de nuevo.");
    setState(next);
    setCurrent(0);
  };

  const finished = state !== null && current < 0;
  const phrase = state && current >= 0 ? state.phrases[current] : undefined;

  return (
    <section ref={dialog} className={`build voice-training${embedded ? " build-embedded" : ""}`} {...(embedded ? {} : { role: "dialog", "aria-modal": true, tabIndex: -1 })} aria-labelledby="voice-title">
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
        {!state && !failed && <p className="build-empty">Cargando…</p>}
        {failed && (
          <div className="build-empty" role="alert">
            <p>No pude cargar las frases. Revisá la conexión.</p>
            <button type="button" className="button" onClick={load}>
              Reintentar
            </button>
          </div>
        )}
        {state && !finished && phrase && (
          <>
            <p className="voice-training-count">
              Frase {current + 1} de {state.phrases.length}
            </p>
            <p className="voice-training-phrase">«{phrase}»</p>
            <div className="voice-training-meter" aria-hidden="true">
              {step === "recording" && <Waveform levels={levels} />}
            </div>
            <button type="button" className="voice-training-record" data-recording={step === "recording"} disabled={step === "uploading" || step === "starting"} aria-label={step === "recording" ? "Terminar la frase" : "Grabar la frase"} onClick={() => void record()}>
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
            <p className="voice-training-hint" role="status">
              {message ?? "En las llamadas ignoro otras voces y ruidos de fondo."}
            </p>
            <button type="button" className="button" onClick={() => void redo()}>
              Volver a grabar
            </button>
          </>
        )}
      </div>
    </section>
  );
}
