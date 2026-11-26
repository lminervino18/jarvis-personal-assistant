import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useDialogFocus } from "../hooks.js";
import { contentUrl, formatSize, previewUrl, type TransferFile } from "../transfers/api.js";
import { useSaveToDevice } from "../transfers/save.js";

const SWIPE_PX = 60;
const TAP_PX = 10;
const DOUBLE_TAP_MS = 300;
const ARMED_MS = 4000;
const MAX_ZOOM = 3;

interface Props {
  items: TransferFile[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  /** Whether this device keeps files through the share sheet (a phone) instead of a download. */
  sharing: boolean;
  onShare(item: TransferFile): Promise<string | null>;
  onConvert(item: TransferFile, format: Conversion): Promise<string | null>;
  onDelete(item: TransferFile): Promise<boolean>;
}

type Conversion = "mp3" | "iphone";
const CONVERSION_NAMES: Record<Conversion, string> = { mp3: "MP3", iphone: "Para iPhone" };

/** What a file can become: a video gives its audio or an iPhone version, a song in another format gives an MP3. */
function conversionsFor(item: TransferFile): Conversion[] {
  if (item.preview === "video") return ["iphone", "mp3"];
  return item.preview === "audio" && !/\.mp3$/i.test(item.name) ? ["mp3"] : [];
}

const SAVE_TEXT = { idle: "Guardar o compartir", ready: "Listo: tocá para guardar", saved: "Guardar o compartir", failed: "No pude traerlo. Reintentar" } as const;

/** The main action on a phone: bring the original and open the share sheet, with «Guardar video» or «Guardar en Archivos». */
function SaveOnPhone({ item }: { item: TransferFile }) {
  const { state, save } = useSaveToDevice(item);
  const text = state.phase === "preparing" ? `Preparando… ${Math.floor(state.progress * 100)} %` : SAVE_TEXT[state.phase];
  return (
    <button type="button" className="button primary" data-phase={state.phase} disabled={state.phase === "preparing"} onClick={() => void save()}>
      {text}
    </button>
  );
}

export function MusicIcon() {
  return (
    <svg className="transfer-music" viewBox="0 0 24 24" aria-hidden="true" width="56" height="56">
      <path fill="currentColor" d="M9 18.5a3 3 0 1 1-2-2.83V5.5l12-2.5v12.5a3 3 0 1 1-2-2.83V7.6L9 9.3v9.2Z" />
    </svg>
  );
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

interface Size {
  width: number;
  height: number;
}

/** Width in pixels to zoom an image to: tall ones fill the width and scroll down, the rest grow up to three times. */
export function zoomWidth(image: Size, stage: Size): number {
  const tall = image.height / image.width > stage.height / stage.width;
  return tall ? stage.width : Math.max(stage.width, Math.min(image.width, stage.width * MAX_ZOOM));
}

/**
 * Full-screen look at one file of Transferencias at a time. Photos always fit the screen and zoom
 * with a double tap or «Ampliar»; videos stream; arrows, keys or a swipe move between files.
 */
export function TransferViewer({ items, index, onIndex, onClose, sharing, onShare, onConvert, onDelete }: Props) {
  const item = items[index];
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
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
    setZoom(null);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return zoom ? setZoom(null) : onClose();
      if (event.key === "ArrowRight" && !zoom) go(1);
      if (event.key === "ArrowLeft" && !zoom) go(-1);
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
  const animated = item.mediaType === "image/gif";
  const zoomable = item.preview === "image" && !unplayable && !animated;

  const toggleZoom = () => {
    if (zoom) return setZoom(null);
    if (!image.current || !stage.current || !image.current.naturalWidth) return;
    setZoom(
      zoomWidth({ width: image.current.naturalWidth, height: image.current.naturalHeight }, { width: stage.current.clientWidth, height: stage.current.clientHeight }),
    );
    requestAnimationFrame(() => stage.current?.scrollTo({ top: 0, left: 0 }));
  };

  const share = async () => {
    setMessage(null);
    const url = await onShare(item);
    if (!url) return setMessage("No pude crear el link. Probá de nuevo.");
    setLink(url);
  };

  const convert = async (format: Conversion) => {
    setMessage(null);
    const error = await onConvert(item, format);
    setMessage(error ?? (format === "mp3" ? "Sacándole el audio: aparece en Transferencias cuando esté." : "Haciendo la versión para iPhone: aparece en Transferencias cuando esté."));
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

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") pointer.current = { x: event.clientX, y: event.clientY };
  };
  const up = (event: PointerEvent) => {
    const start = pointer.current;
    pointer.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < TAP_PX && Math.abs(event.clientY - start.y) < TAP_PX) {
      if (zoomable && event.timeStamp - lastTap.current < DOUBLE_TAP_MS) toggleZoom();
      lastTap.current = event.timeStamp;
      return;
    }
    if (!zoom && Math.abs(dx) > SWIPE_PX) go(dx < 0 ? 1 : -1);
  };

  const arrow = (step: -1 | 1) => (
    <button
      type="button"
      className={`glass-button glass transfer-nav ${step < 0 ? "prev" : "next"}`}
      aria-label={step < 0 ? "Anterior" : "Siguiente"}
      disabled={index + step < 0 || index + step >= items.length}
      onClick={() => go(step)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
        <path fill="currentColor" d={step < 0 ? "M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6Z" : "M8.6 17.6 10 19l7-7-7-7-1.4 1.4 5.6 5.6-5.6 5.6Z"} />
      </svg>
    </button>
  );

  return (
    <div ref={dialog} className="transfer-viewer" role="dialog" aria-modal="true" aria-label={`Archivo ${index + 1} de ${items.length}: ${item.name}`} tabIndex={-1}>
      <header className="transfer-viewer-head">
        <div className="transfer-viewer-title">
          <strong>{item.name}</strong>
          <span>
            {formatSize(item.size)} · {index + 1} de {items.length}
          </span>
        </div>
        <div className="transfer-viewer-tools">
          {zoomable && (
            <button type="button" className="glass-button glass" aria-label={zoom ? "Ajustar a la pantalla" : "Ampliar"} aria-pressed={zoom !== null} onClick={toggleZoom}>
              <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                <path
                  fill="currentColor"
                  d={
                    zoom
                      ? "M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM7 9h6v2H7V9Z"
                      : "M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm-1 2h2v2h2v2h-2v2H9v-2H7V9h2V7Z"
                  }
                />
              </svg>
            </button>
          )}
          {arrow(-1)}
          {arrow(1)}
          <button type="button" className="glass-button glass" aria-label="Cerrar" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
              <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
            </svg>
          </button>
        </div>
      </header>

      <div ref={stage} className="transfer-viewer-stage" data-zoom={zoom !== null} onPointerDown={down} onPointerUp={up} onPointerCancel={() => (pointer.current = null)}>
        {animated && !unplayable && <img key={item.id} src={contentUrl(item.id)} alt={item.name} draggable={false} onError={() => setUnplayable(true)} />}
        {item.preview === "audio" && !unplayable && (
          <div className="transfer-audio">
            <MusicIcon />
            <audio key={item.id} src={contentUrl(item.id)} controls preload="metadata" onError={() => setUnplayable(true)} />
          </div>
        )}
        {zoomable && (
          <img
            ref={image}
            key={item.id}
            src={previewUrl(item.id, "large")}
            alt={item.name}
            draggable={false}
            style={zoom ? { width: zoom } : undefined}
            onDoubleClick={toggleZoom}
            onError={() => setUnplayable(true)}
          />
        )}
        {item.preview === "video" && !unplayable && (
          <video key={item.id} src={contentUrl(item.id)} poster={previewUrl(item.id, "thumb")} controls playsInline preload="metadata" onError={() => setUnplayable(true)} />
        )}
        {(!item.preview || unplayable) && (
          <div className="transfer-unplayable">
            <FileIcon name={item.name} />
            {unplayable && <p>No se puede ver acá. Bajalo para abrirlo con otra app.</p>}
          </div>
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
        {conversionsFor(item).length > 0 && (
          <div className="transfer-convert">
            <span>Convertir a</span>
            {conversionsFor(item).map((format) => (
              <button key={format} type="button" className="row-link" onClick={() => void convert(format)}>
                {CONVERSION_NAMES[format]}
              </button>
            ))}
          </div>
        )}
        <div className="transfer-buttons">
          {sharing ? (
            <SaveOnPhone key={item.id} item={item} />
          ) : (
            <a className="button primary" href={contentUrl(item.id)} download={item.name}>
              Bajar original
            </a>
          )}
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
