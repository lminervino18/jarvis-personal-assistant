import { fetchEnrollment } from "../voice/enrollment-api.js";
import { ConnectionsGroup } from "./ConnectionsGroup.js";
import { UsageGroup } from "./UsageGroup.js";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useDialogFocus } from "../hooks.js";
import type { PushResult } from "../conversation/session.js";
import { readPushStatus, type PushStatus } from "../pwa/push.js";

interface Props {
  speech: boolean;
  speakerOn: boolean;
  online: boolean;
  demo?: boolean;
  onToggleSpeaker(): void;
  onEnablePush(): Promise<PushResult>;
  onLogout?(): void;
  /** Opens the voice training; without it the row is hidden. */
  onTrainVoice?(): void;
}

function VoiceRow({ onTrain }: { onTrain(): void }) {
  const [enrolled, setEnrolled] = useState(false);
  useEffect(() => void fetchEnrollment().then((state) => setEnrolled(state?.enrolled === true)), []);
  return (
    <div className="group">
      <div className="row">
        <span>Reconocer mi voz</span>
        <button type="button" className="row-link" onClick={onTrain}>
          {enrolled ? "Volver a entrenar" : "Entrenar"}
        </button>
      </div>
      <p className="group-footer">{enrolled ? "En las llamadas solo te escucho a vos: ignoro otras voces y ruidos." : "Leés ocho frases y aprendo tu voz, para ignorar otras voces en las llamadas."}</p>
    </div>
  );
}

const pushLabel: Record<PushStatus, string> = {
  install: "Requiere instalar",
  unsupported: "No disponible",
  blocked: "Bloqueadas",
  off: "Desactivadas",
  on: "Activadas",
};

const pushHelp: Record<PushStatus, string> = {
  install: "En el iPhone, tocá Compartir y elegí «Agregar a inicio». Después abrí Jarvis desde el ícono y volvé acá.",
  unsupported: "Este navegador no permite notificaciones.",
  blocked: "Las bloqueaste antes. Habilitalas en Ajustes del iPhone › Notificaciones › Jarvis.",
  off: "Te aviso de recordatorios, tareas terminadas y lo que me pidas.",
  on: "Probalo: decime «recordame tomar agua en un minuto» y bloqueá el teléfono.",
};

function usePushStatus(): [PushStatus | null, () => void] {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    void readPushStatus().then((next) => alive && setStatus(next));
    return () => {
      alive = false;
    };
  }, [version]);
  return [status, () => setVersion((current) => current + 1)];
}

/** The settings themselves: voice, notifications and the account. */
export function Settings({ speech, speakerOn, online, demo, onToggleSpeaker, onEnablePush, onLogout, onTrainVoice }: Props) {
  const [push, refreshPush] = usePushStatus();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const enablePush = async () => {
    setBusy(true);
    const result = await onEnablePush();
    setBusy(false);
    setMessage(result.ok ? null : result.message);
    refreshPush();
  };

  return (
    <>
      {speech && (
        <div className="group">
          <label className="row">
            <span>Leer respuestas en voz alta</span>
            <input type="checkbox" role="switch" className="switch" checked={speakerOn} onChange={onToggleSpeaker} />
          </label>
          <p className="group-footer">En la llamada siempre te respondo hablando.</p>
        </div>
      )}

      <div className="group">
        <div className="row">
          <span>Notificaciones</span>
          <span className="row-value" data-status={push ?? "off"}>
            {push ? pushLabel[push] : "…"}
          </span>
        </div>
        {push === "off" && (
          <button type="button" className="row row-action" disabled={busy || !online} onClick={() => void enablePush()}>
            {busy ? "Activando…" : "Activar notificaciones"}
          </button>
        )}
        <p className="group-footer" role="status">
          {message ?? (push ? pushHelp[push] : "")}
        </p>
      </div>

      {!demo && onTrainVoice && <VoiceRow onTrain={onTrainVoice} />}

      {!demo && <ConnectionsGroup />}

      {!demo && <UsageGroup />}

      {onLogout && (
        <div className="group">
          <button type="button" className="row row-action row-danger" onClick={onLogout}>
            Cerrar sesión
          </button>
        </div>
      )}
      {demo && <p className="group-footer">Modo demo: datos ficticios.</p>}
    </>
  );
}

const DISMISS_PX = 80;

/** iOS-style settings sheet for the phone; dragging its header down closes it, like «Listo». */
export function SettingsSheet({ onClose, ...settings }: Props & { onClose(): void }) {
  const sheet = useRef<HTMLElement>(null);
  const drag = useRef<{ start: number; distance: number } | null>(null);
  useDialogFocus(sheet);

  const move = (distance: number, animate: boolean) => {
    const element = sheet.current;
    if (!element) return;
    element.style.transition = animate ? "transform 0.2s ease-out" : "none";
    element.style.transform = distance > 0 ? `translateY(${distance}px)` : "";
  };
  const grab = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    drag.current = { start: event.clientY, distance: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pull = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.distance = Math.max(0, event.clientY - drag.current.start);
    move(drag.current.distance, false);
  };
  const release = () => {
    const distance = drag.current?.distance ?? 0;
    drag.current = null;
    if (distance > DISMISS_PX) return onClose();
    move(0, true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" onPointerDown={grab} onPointerMove={pull} onPointerUp={release} onPointerCancel={release}>
          <span className="sheet-grabber" aria-hidden="true" />
          <header className="sheet-header">
            <h2 id="settings-title">Configuración</h2>
            <button type="button" className="sheet-done" onClick={onClose}>
              Listo
            </button>
          </header>
        </div>
        <Settings {...settings} />
      </section>
    </div>
  );
}
