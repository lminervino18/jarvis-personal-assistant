import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useDialogFocus } from "../hooks.js";
import {
  cancelDownload,
  contentUrl,
  convertTransfer,
  createUploadLink,
  deleteTransfer,
  fetchTransfers,
  formatSize,
  previewUrl,
  revokeUploadLink,
  shareTransfer,
  zipTransfers,
  startDownload,
  timeLeft,
  type MediaFormat,
  type MediaJob,
  type TransferFile,
  type TransfersState,
} from "../transfers/api.js";
import { savesBySharing, useSaveToDevice } from "../transfers/save.js";
import { ownerUploads, TRANSFER_ARRIVED, type UploadItem, type UploadQueue } from "../transfers/uploads.js";
import { MusicIcon, TransferViewer } from "./TransferViewer.js";

const REFRESH_MS = 15_000;
const ARMED_MS = 4000;
/** How long a finished upload stays listed before only its tile remains. */
const DONE_VISIBLE_MS = 4000;

const origins = { phone: "Desde el celu", computer: "Desde una compu", link: "Por link", download: "Bajado de internet" } as const;
const ACTIVE_REFRESH_MS = 2000;

function from(item: TransferFile): string {
  return (item.origin === "link" || item.origin === "download") && item.sender ? `De ${item.sender}` : origins[item.origin];
}

const DOWNLOAD_FORMATS: { format: MediaFormat; label: string; hint: string }[] = [
  { format: "iphone", label: "Video", hint: "H.264 hasta 1080p: se guarda en Fotos del iPhone." },
  { format: "max", label: "Máxima", hint: "La mejor que haya (4K en AV1 o VP9): para la compu, el iPhone 15 no lo guarda." },
  { format: "mp3", label: "Solo audio", hint: "MP3, para escuchar o mandar una canción." },
];
const FORMAT_SHORT: Record<MediaFormat, string> = { iphone: "para iPhone", max: "máxima calidad", mp3: "MP3", m4a: "M4A" };

function jobTitle(job: MediaJob): string {
  if (job.edit) return `Recorte · ${job.source === "search" ? `«${job.label}»` : job.label}`;
  if (job.source === "transfer") return `${job.label} → ${FORMAT_SHORT[job.format]}`;
  return job.source === "search" ? `YouTube · «${job.label}» · ${FORMAT_SHORT[job.format]}` : `${job.site} · ${job.label}`;
}

function jobStatus(job: MediaJob, now: Date): string {
  if (job.status === "failed") return "Falló";
  if (job.status === "running") return `${job.stage ?? (job.source === "transfer" ? "Convirtiendo" : "Bajando")} · ${Math.floor(job.progress * 100)} %`;
  return job.retryAt ? `Reintenta en ${timeLeft(job.retryAt, now)}` : "En espera";
}

/** A link from YouTube, X or Instagram, or words to search on YouTube: the server downloads the video or only its audio. */
function DownloadFromLink({ jobs, now, onChange }: { jobs: MediaJob[]; now: Date; onChange(): void }) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<MediaFormat>("iphone");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = jobs.filter((job) => job.status !== "done" && job.status !== "cancelled");

  const run = async (request: () => Promise<string | null>, clear: boolean) => {
    setBusy(true);
    setMessage(null);
    const error = await request();
    setBusy(false);
    if (error) return setMessage(error);
    if (clear) setText("");
    onChange();
  };
  const retry = (job: MediaJob) =>
    void run(() => (job.source === "transfer" ? convertTransfer(job.target, job.format === "max" ? "iphone" : job.format) : startDownload(job.target, job.format)), false);

  return (
    <section className="transfer-download" aria-labelledby="transfer-download-title">
      <h3 id="transfer-download-title">Bajar un video o una canción</h3>
      <form
        className="transfer-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) void run(() => startDownload(text, format), true);
        }}
      >
        <label className="sr-only" htmlFor="transfer-download-url">
          Link de YouTube, X o Instagram, o qué buscar en YouTube
        </label>
        <input
          id="transfer-download-url"
          type="text"
          enterKeyHint="go"
          autoComplete="off"
          value={text}
          placeholder="Pegá un link o escribí qué buscar en YouTube"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="button primary" disabled={busy || !text.trim()}>
          {busy ? "Pidiendo…" : "Bajar"}
        </button>
      </form>
      <div className="transfer-formats" role="radiogroup" aria-label="Formato">
        {DOWNLOAD_FORMATS.map((option) => (
          <button key={option.format} type="button" role="radio" aria-checked={format === option.format} className="transfer-format" onClick={() => setFormat(option.format)}>
            {option.label}
          </button>
        ))}
      </div>
      <p className="transfer-hint">{DOWNLOAD_FORMATS.find((option) => option.format === format)?.hint}</p>
      {message && (
        <p className="transfer-message" role="alert">
          {message}
        </p>
      )}
      {pending.length > 0 && (
        <ul className="transfer-uploads" aria-label="Descargas y conversiones">
          {pending.map((job) => (
            <li key={job.id} className="transfer-upload" data-status={job.status === "failed" ? "failed" : "uploading"}>
              <div className="transfer-upload-head">
                <span className="transfer-upload-name">{jobTitle(job)}</span>
                <span className="transfer-upload-status">{jobStatus(job, now)}</span>
              </div>
              {job.status !== "failed" && (
                <div className="transfer-bar" role="progressbar" aria-label={jobTitle(job)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(job.progress * 100)}>
                  <div style={{ transform: `scaleX(${Math.max(0.02, job.progress)})` }} />
                </div>
              )}
              {job.error && <p className="transfer-upload-error">{job.error}</p>}
              {job.sendTo && job.status !== "failed" && <p className="transfer-upload-note">Cuando esté, se lo mando a {job.sendTo}.</p>}
              <div className="transfer-download-actions">
                {job.status === "failed" ? (
                  <button type="button" className="row-link" onClick={() => retry(job)}>
                    Reintentar
                  </button>
                ) : (
                  <button type="button" className="row-link row-link-danger" onClick={() => void cancelDownload(job.id).then(onChange)}>
                    Cancelar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Uploads in progress, shared by Transferencias and the public upload page. */
export function UploadProgress({ queue }: { queue: UploadQueue }) {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  if (items.length === 0) return null;
  const status = (item: UploadItem) => (item.status === "uploading" ? `${Math.floor(item.progress * 100)} %` : item.status === "done" ? "Listo" : "Falló");
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
            <>
              <p className="transfer-upload-error">{item.error ?? "Se cortó la subida."}</p>
              <button type="button" className="row-link" onClick={() => queue.retry(item.key)}>
                Reintentar
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ShareGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}>
      <path fill="currentColor" d="m12 2.6 4.7 4.7-1.4 1.4L13 6.4V15h-2V6.4L8.7 8.7 7.3 7.3 12 2.6ZM5 10h4v2H7v8h10v-8h-2v-2h4v12H5V10Z" />
    </svg>
  );
}

/** On a phone, the tile's button brings the original and opens the share sheet to keep it in Photos or Files. */
function TileSave({ item }: { item: TransferFile }) {
  const { state, save } = useSaveToDevice(item);
  const label = state.phase === "preparing" ? `${Math.floor(state.progress * 100)} %` : state.phase === "ready" ? "Guardar" : state.phase === "failed" ? "Reintentar" : null;
  const aria = state.phase === "preparing" ? `Preparando ${item.name}` : state.phase === "ready" ? `Guardar ${item.name}: listo` : `Guardar o compartir ${item.name}`;
  return (
    <button type="button" className="transfer-tile-download glass" data-phase={state.phase} aria-label={aria} onClick={() => void save()}>
      {label ?? <ShareGlyph />}
    </button>
  );
}

interface TileProps {
  item: TransferFile;
  now: Date;
  sharing: boolean;
  /** Set while picking several files: a tap toggles this one instead of opening it. */
  selected?: boolean;
  onOpen(): void;
  onDelete(item: TransferFile): Promise<boolean>;
}

function Tile({ item, now, sharing, selected, onOpen, onDelete }: TileProps) {
  const [broken, setBroken] = useState(false);
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const remove = async () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    setDeleting(true);
    if (!(await onDelete(item))) setDeleting(false);
  };
  return (
    <li className="transfer-item" data-selected={selected}>
      <button
        type="button"
        className="transfer-tile"
        onClick={onOpen}
        aria-pressed={selected}
        aria-label={selected === undefined ? `Ver ${item.name}, ${formatSize(item.size)}, ${from(item).toLowerCase()}` : `${selected ? "Quitar" : "Elegir"} ${item.name}`}
      >
        <span className="transfer-thumb" data-kind={item.preview ?? "file"}>
          {item.preview === "audio" ? (
            <MusicIcon />
          ) : item.preview && !broken ? (
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
        {selected !== undefined && (
          <span className="transfer-check" aria-hidden="true">
            {selected ? "✓" : ""}
          </span>
        )}
        <span className="transfer-name">{item.name}</span>
        <span className="transfer-meta">
          {formatSize(item.size)} · {from(item)} · se borra en {timeLeft(item.expiresAt, now)}
        </span>
      </button>
      {selected === undefined && (
        <button
          type="button"
          className="transfer-tile-delete glass"
          data-armed={armed}
          disabled={deleting}
          aria-label={armed ? `Confirmar: borrar ${item.name}` : `Borrar ${item.name}`}
          onClick={() => void remove()}
        >
          {armed ? (
            "¿Borrar?"
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
              <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
            </svg>
          )}
        </button>
      )}
      {selected !== undefined ? null : sharing ? (
        <TileSave item={item} />
      ) : (
        <a className="transfer-tile-download glass" href={contentUrl(item.id)} download={item.name} aria-label={`Bajar ${item.name}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
            <path fill="currentColor" d="M11 4h2v9.2l3.3-3.3 1.4 1.4-5.7 5.7-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5v-2Z" />
          </svg>
        </a>
      )}
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

  const sharing = useState(savesBySharing)[0];
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [zipMessage, setZipMessage] = useState<string | null>(null);
  const downloading = typeof state === "object" && (state.jobs ?? []).some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(refresh, ACTIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [downloading, refresh]);

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

  const removeFile = async (item: TransferFile) => {
    const done = await deleteTransfer(item.id);
    if (done) refresh();
    return done;
  };
  const now = new Date();

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** The picked files in one ZIP: a download on a computer, Safari's own download on a phone (never the app's memory). */
  const downloadPicked = async () => {
    if (!picked?.size) return;
    const tab = sharing ? window.open("", "_blank") : null;
    const zip = await zipTransfers([...picked]);
    if (!zip) {
      tab?.close();
      setZipMessage("No pude armar el ZIP: es más grande que 4 GB o los archivos ya no están. Bajalos de a uno.");
      return;
    }
    if (tab) tab.location.href = zip.url;
    else {
      const link = document.createElement("a");
      link.href = zip.url;
      link.download = "Transferencias.zip";
      link.click();
    }
    setZipMessage(null);
    setPicked(null);
  };
  const pickedBytes = items.filter((item) => picked?.has(item.id)).reduce((total, item) => total + item.size, 0);

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

        {typeof state === "object" && state.jobs && <DownloadFromLink jobs={state.jobs} now={now} onChange={refresh} />}

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
        {items.length > 1 && (
          <div className="transfer-pick">
            {picked ? (
              <>
                <button type="button" className="row-link" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}>
                  {picked.size === items.length ? "Ninguno" : "Todos"}
                </button>
                <button type="button" className="button primary" disabled={picked.size === 0} onClick={() => void downloadPicked()}>
                  {picked.size === 0 ? "Elegí archivos" : `Bajar ${picked.size} en un ZIP (${formatSize(pickedBytes)})`}
                </button>
                <button type="button" className="row-link" onClick={() => setPicked(null)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button type="button" className="row-link" onClick={() => setPicked(new Set())}>
                Seleccionar
              </button>
            )}
          </div>
        )}
        {zipMessage && (
          <p className="transfer-message" role="alert">
            {zipMessage}
          </p>
        )}
        {items.length > 0 && (
          <ul className="transfer-grid" aria-label="Archivos">
            {items.map((item, index) => (
              <Tile
                key={item.id}
                item={item}
                now={now}
                sharing={sharing}
                {...(picked ? { selected: picked.has(item.id) } : {})}
                onOpen={() => (picked ? toggle(item.id) : setOpen(index))}
                onDelete={removeFile}
              />
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
          sharing={sharing}
          onShare={async (item) => (await shareTransfer(item.id))?.url ?? null}
          onConvert={async (item, format) => {
            const error = await convertTransfer(item.id, format);
            if (!error) refresh();
            return error;
          }}
          onDelete={async (item) => {
            const done = await removeFile(item);
            if (done) setOpen(items.length > 1 ? Math.min(open, items.length - 2) : null);
            return done;
          }}
        />
      )}
    </section>
  );
}
