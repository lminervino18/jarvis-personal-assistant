import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useDialogFocus } from "../hooks.js";
import {
  createUploadLink,
  deleteTransfer,
  fetchTransfers,
  formatSize,
  previewUrl,
  revokeUploadLink,
  shareTransfer,
  timeLeft,
  type TransferFile,
  type TransfersState,
} from "../transfers/api.js";
import { ownerUploads, TRANSFER_ARRIVED, type UploadItem, type UploadQueue } from "../transfers/uploads.js";
import { TransferViewer } from "./TransferViewer.js";

const REFRESH_MS = 15_000;
/** How long a finished upload stays listed before only its tile remains. */
const DONE_VISIBLE_MS = 4000;

const origins = { phone: "Desde el celu", computer: "Desde una compu", link: "Por link" } as const;

function from(item: TransferFile): string {
  return item.origin === "link" && item.sender ? `De ${item.sender}` : origins[item.origin];
}

/** Uploads in progress, shared by Transferencias and the public upload page. */
export function UploadProgress({ queue }: { queue: UploadQueue }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  if (items.length === 0) return null;
  const status = (item: UploadItem) =>
    item.status === "uploading" ? `${Math.floor(item.progress * 100)} %` : item.status === "done" ? "Listo" : (item.error ?? "Se cortó la subida.");
  return (
    <ul className="transfer-uploads" aria-label="Subidas">
      {items.map((item) => (
        <li key={item.key} className="transfer-upload" data-status={item.status}>
          <div className="transfer-upload-head">
            <span className="transfer-upload-name">{item.name}</span>
            <span className="transfer-upload-status">{status(item)}</span>
          </div>
          <div className="transfer-bar" role="progressbar" aria-label={`Subiendo ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(item.progress * 100)}>
            <div style={{ transform: `scaleX(${item.status === "uploading" ? Math.max(0.02, item.progress) : 1})` }} />
          </div>
          {item.status === "failed" && (
            <button type="button" className="row-link" onClick={() => queue.retry(item.key)}>
              Reintentar
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Tile({ item, now, onOpen }: { item: TransferFile; now: Date; onOpen(): void }) {
  const [broken, setBroken] = useState(false);
  return (
    <li>
      <button type="button" className="transfer-tile" onClick={onOpen} aria-label={`${item.name}, ${formatSize(item.size)}, ${from(item).toLowerCase()}`}>
        <span className="transfer-thumb" data-kind={item.preview ?? "file"}>
          {item.preview && !broken ? (
            <img src={previewUrl(item.id, "thumb")} alt="" loading="lazy" onError={() => setBroken(true)} />
          ) : (
            <span className="transfer-ext">{item.name.split(".").pop()?.toUpperCase().slice(0, 5)}</span>
          )}
          {item.preview === "video" && !broken && (
            <svg className="transfer-play" viewBox="0 0 24 24" aria-hidden="true" width="28" height="28">
              <path fill="currentColor" d="M8 5v14l11-7L8 5Z" />
            </svg>
          )}
        </span>
        <span className="transfer-name">{item.name}</span>
        <span className="transfer-meta">
          {formatSize(item.size)} · {from(item)} · se borra en {timeLeft(item.expiresAt, now)}
        </span>
      </button>
    </li>
  );
}

function UploadLinks({ links, onChange }: { links: TransfersState["links"]; onChange(): void }) {
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setMessage(null);
    const result = await createUploadLink(label.trim() || undefined);
    setBusy(false);
    if (!result) return setMessage("No pude crear el link. Probá de nuevo.");
    setCreated(result.url);
    setLabel("");
    onChange();
  };

  const copy = async () => {
    const copied = created ? await navigator.clipboard?.writeText(created).then(() => true, () => false) : false;
    setMessage(copied ? "Link copiado." : "Mantené apretado el link para copiarlo.");
  };

  return (
    <section className="transfer-links" aria-labelledby="transfer-links-title">
      <h3 id="transfer-links-title">Que te manden archivos</h3>
      <p className="row-muted">Un link de 24 horas para que alguien te suba fotos o videos sin cuenta y sin perder calidad.</p>
      <div className="transfer-link-form">
        <label className="sr-only" htmlFor="transfer-link-label">
          ¿Para quién es?
        </label>
        <input id="transfer-link-label" value={label} maxLength={60} placeholder="¿Para quién? (opcional)" onChange={(event) => setLabel(event.target.value)} />
        <button type="button" className="button primary" disabled={busy} onClick={() => void create()}>
          {busy ? "Creando…" : "Crear link"}
        </button>
      </div>
      {created && (
        <div className="transfer-link">
          <input readOnly value={created} aria-label="Link para subir archivos" onFocus={(event) => event.target.select()} />
          <button type="button" className="button" onClick={() => void copy()}>
            Copiar
          </button>
          {"share" in navigator && (
            <button type="button" className="button" onClick={() => void navigator.share({ url: created, title: "Subí tus archivos" }).catch(() => undefined)}>
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
      {links.length > 0 && (
        <ul className="transfer-link-list">
          {links.map((link) => (
            <li key={link.id}>
              <span>
                {link.label ? `Para ${link.label}` : "Link sin nombre"} · vence en {timeLeft(link.expiresAt, new Date())}
              </span>
              <button type="button" className="row-link row-link-danger" onClick={() => void revokeUploadLink(link.id).then(onChange)}>
                Revocar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Props {
  onClose(): void;
  /** Shown inside the wide layout's main panel instead of covering the screen. */
  embedded?: boolean;
}

/**
 * Transferencias: files kept in their original quality for a day, to pass them between the phone
 * and any computer, or from someone with a link. Photos and videos show small; tapping one opens it.
 */
export function TransfersScreen({ onClose, embedded }: Props) {
  const [state, setState] = useState<TransfersState | "loading" | "failed">("loading");
  const [open, setOpen] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, !embedded);

  const refresh = useCallback(() => void fetchTransfers().then((next) => setState(next ?? "failed")), []);
  const arrived = useCallback(() => {
    refresh();
    setTimeout(() => !ownerUploads.busy() && ownerUploads.clearDone(), DONE_VISIBLE_MS);
  }, [refresh]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener(TRANSFER_ARRIVED, arrived);
    return () => {
      clearInterval(timer);
      window.removeEventListener(TRANSFER_ARRIVED, arrived);
    };
  }, [refresh, arrived]);

  useEffect(() => {
    if (embedded || open !== null) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, open, onClose]);

  const upload = (files: readonly File[]) => {
    if (files.length > 0) ownerUploads.add(files, arrived);
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    upload([...event.dataTransfer.files]);
  };

  const items = typeof state === "object" ? state.items : [];
  const now = new Date();

  return (
    <section
      ref={dialog}
      className={`build transfers${embedded ? " build-embedded" : ""}`}
      {...(embedded ? {} : { role: "dialog", "aria-modal": true, tabIndex: -1 })}
      aria-labelledby="transfers-title"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)}
      onDrop={drop}
      data-dragging={dragging}
    >
      <header className="build-header">
        <div>
          <h2 id="transfers-title">Transferencias</h2>
          <p>En calidad original, entre el celu y cualquier compu. Todo se borra a las 24 horas.</p>
        </div>
        {!embedded && (
          <button type="button" className="build-done" onClick={onClose}>
            Listo
          </button>
        )}
      </header>

      <div className="build-list transfers-body">
        <button type="button" className="transfer-drop" onClick={() => picker.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="26" height="26">
            <path fill="currentColor" d="M11 16V7.8l-3.3 3.3-1.4-1.4L12 4l5.7 5.7-1.4 1.4L13 7.8V16h-2Zm-6 4v-2h14v2H5Z" />
          </svg>
          <span>
            <strong>Subir archivos</strong>
            <small>{dragging ? "Soltalos acá" : "Fotos, videos o lo que sea, sin comprimir"}</small>
          </span>
        </button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => (upload([...(event.target.files ?? [])]), (event.target.value = ""))} />

        <UploadProgress queue={ownerUploads} />

        {state === "loading" && <p className="build-empty">Cargando…</p>}
        {state === "failed" && (
          <div className="build-empty" role="alert">
            <p>No pude ver las transferencias. Revisá la conexión.</p>
            <button type="button" className="button" onClick={refresh}>
              Reintentar
            </button>
          </div>
        )}
        {typeof state === "object" && items.length === 0 && <p className="build-empty">Todavía no hay nada. Subí algo desde acá o desde el «+» del chat.</p>}
        {items.length > 0 && (
          <ul className="transfer-grid" aria-label="Archivos">
            {items.map((item, index) => (
              <Tile key={item.id} item={item} now={now} onOpen={() => setOpen(index)} />
            ))}
          </ul>
        )}

        {typeof state === "object" && <UploadLinks links={state.links} onChange={refresh} />}
      </div>

      {open !== null && (
        <TransferViewer
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onShare={async (item) => (await shareTransfer(item.id))?.url ?? null}
          onDelete={async (item) => {
            const done = await deleteTransfer(item.id);
            if (!done) return false;
            setOpen(items.length > 1 ? Math.min(open, items.length - 2) : null);
            refresh();
            return true;
          }}
        />
      )}
    </section>
  );
}
