import { ConnectionsGroup } from "./ConnectionsGroup.js";
import { useEffect, useState } from "react";
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
export function Settings({ speech, speakerOn, online, demo, onToggleSpeaker, onEnablePush, onLogout }: Props) {
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

      {!demo && <ConnectionsGroup online={online} />}

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

/** iOS-style settings sheet for the phone. */
export function SettingsSheet({ onClose, ...settings }: Props & { onClose(): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-grabber" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="settings-title">Configuración</h2>
          <button type="button" className="sheet-done" onClick={onClose}>
            Listo
          </button>
        </header>
        <Settings {...settings} />
      </section>
    </div>
  );
}
