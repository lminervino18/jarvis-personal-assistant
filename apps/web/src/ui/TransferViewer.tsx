import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useDialogFocus } from "../hooks.js";
import { contentUrl, formatSize, previewUrl, type TransferFile } from "../transfers/api.js";

const SWIPE_PX = 60;
const ARMED_MS = 4000;

interface Props {
  items: TransferFile[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  onShare(item: TransferFile): Promise<string | null>;
  onDelete(item: TransferFile): Promise<boolean>;
}

function FileIcon({ name }: { name: string }) {
  return (
    <div className="transfer-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="44" height="44">
        <path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5L13 3.5Z" />
      </svg>
      <span>{name.split(".").pop()?.toUpperCase().slice(0, 5)}</span>
    </div>
  );
}

/** Full-screen look at one file of Transferencias at a time: photos large, videos streamed, the rest by name; arrows, keys or a swipe move between them. */
export function TransferViewer({ items, index, onIndex, onClose, onShare, onDelete }: Props) {
  const item = items[index];
  const dialog = useRef<HTMLDivElement>(null);
  const swipe = useRef<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  useDialogFocus(dialog);

  const go = (step: number) => {
    const next = index + step;
    if (next >= 0 && next < items.length) onIndex(next);
  };

  useEffect(() => {
    setLink(null);
    setMessage(null);
    setArmed(false);
    setUnplayable(false);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!item) return null;

  const share = async () => {
    setMessage(null);
    const url = await onShare(item);
    if (!url) return setMessage("No pude crear el link. Probá de nuevo.");
    setLink(url);
  };

  const copy = async () => {
    if (!link) return;
    const copied = await navigator.clipboard?.writeText(link).then(() => true, () => false);
    setMessage(copied ? "Link copiado." : "Mantené apretado el link para copiarlo.");
  };

  const remove = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    if (!(await onDelete(item))) setMessage("No pude borrarlo. Probá de nuevo.");
  };

  const start = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") swipe.current = event.clientX;
  };
  const end = (event: PointerEvent) => {
    if (swipe.current === null) return;
    const distance = event.clientX - swipe.current;
    swipe.current = null;
    if (Math.abs(distance) > SWIPE_PX) go(distance < 0 ? 1 : -1);
  };

  return (
    <div ref={dialog} className="transfer-viewer" role="dialog" aria-modal="true" aria-label={`Archivo ${index + 1} de ${items.length}: ${item.name}`} tabIndex={-1}>
      <header className="transfer-viewer-head">
        <div className="transfer-viewer-title">
          <strong>{item.name}</strong>
          <span>
            {formatSize(item.size)} · {index + 1} de {items.length}
          </span>
        </div>
        <button type="button" className="glass-button glass" aria-label="Cerrar" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
            <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
          </svg>
        </button>
      </header>

      <div className="transfer-viewer-stage" onPointerDown={start} onPointerUp={end} onPointerCancel={() => (swipe.current = null)}>
        {item.preview === "image" && !unplayable && <img key={item.id} src={previewUrl(item.id, "large")} alt={item.name} draggable={false} onError={() => setUnplayable(true)} />}
        {item.preview === "video" && !unplayable && (
          <video key={item.id} src={contentUrl(item.id)} poster={previewUrl(item.id, "thumb")} controls playsInline preload="metadata" onError={() => setUnplayable(true)} />
        )}
        {(!item.preview || unplayable) && (
          <div className="transfer-unplayable">
            <FileIcon name={item.name} />
            {unplayable && <p>No se puede ver acá. Bajalo para abrirlo con otra app.</p>}
          </div>
        )}
        {index > 0 && (
          <button type="button" className="glass-button glass transfer-nav prev" aria-label="Anterior" onClick={() => go(-1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6Z" />
            </svg>
          </button>
        )}
        {index < items.length - 1 && (
          <button type="button" className="glass-button glass transfer-nav next" aria-label="Siguiente" onClick={() => go(1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M8.6 17.6 10 19l7-7-7-7-1.4 1.4 5.6 5.6-5.6 5.6Z" />
            </svg>
          </button>
        )}
      </div>

      <footer className="transfer-viewer-actions">
        {link && (
          <div className="transfer-link">
            <input readOnly value={link} aria-label="Link para compartir" onFocus={(event) => event.target.select()} />
            <button type="button" className="button" onClick={() => void copy()}>
              Copiar
            </button>
            {"share" in navigator && (
              <button type="button" className="button" onClick={() => void navigator.share({ url: link, title: item.name }).catch(() => undefined)}>
                Compartir
              </button>
            )}
          </div>
        )}
        {message && (
          <p className="transfer-message" role="status">
            {message}
          </p>
        )}
        <div className="transfer-buttons">
          <a className="button primary" href={contentUrl(item.id)} download={item.name}>
            Bajar original
          </a>
          {!link && (
            <button type="button" className="button" onClick={() => void share()}>
              Compartir link
            </button>
          )}
          <button type="button" className="button danger" onClick={() => void remove()}>
            {armed ? "Confirmar" : "Borrar"}
          </button>
        </div>
      </footer>
    </div>
  );
}
