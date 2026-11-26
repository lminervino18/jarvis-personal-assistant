import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { MediaFormat } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE } from "../push/notification.js";
import { safeFileName } from "../tasks/workspace.js";
import type { SendOutcome, SendRequest } from "../transfers/transfer-delivery.js";
import type { Transfer, TransferOrigin, TransferStore } from "../transfers/transfer-store.js";
import { Outbox } from "../worker/outbox.js";
import type { ConvertFormat, MediaConverter } from "./media-converter.js";
import { DownloadError, siteOf, type DownloadFailure, type MediaDownloader, type Site } from "./media-downloader.js";
import { clock, padded, type Moment, type MomentFinder } from "./moment-finder.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** What to keep of a video: the parts the owner described, or the exact times they gave. */
export interface EditSpec {
  find?: string;
  segments?: Moment[];
  /** Seconds kept before and after each moment found. */
  padding: number;
  vertical: boolean;
  /** Whether the whole video also stays in Transferencias. */
  keepSource: boolean;
}
export type JobSource = "link" | "search" | "transfer";

export interface MediaJob {
  id: string;
  source: JobSource;
  /** The link, the words searched on YouTube, or the id of the Transferencias file to convert. */
  target: string;
  /** YouTube, X, Instagram, or Transferencias for a conversion. */
  site: string;
  format: MediaFormat;
  send?: SendRequest;
  /** Present when the job cuts a video instead of keeping it whole. */
  edit?: EditSpec;
  /** What a long job is doing now («Buscando el momento»). */
  stage?: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  /** When a download YouTube blocked is tried again. */
  retryAt?: string;
  error?: string;
  transferId?: string;
  createdAt: string;
}

interface Row {
  id: string;
  source: JobSource;
  target: string;
  site: string;
  format: MediaFormat;
  send_json: string | null;
  edit_json: string | null;
  stage: string | null;
  status: JobStatus;
  progress: number;
  attempts: number;
  not_before: string | null;
  error: string | null;
  transfer_id: string | null;
  created_at: string;
}

/** What the owner reads when a job fails; the raw tool output never reaches them or the model. */
export const FAILURES: Record<DownloadFailure, string> = {
  blocked: "YouTube bloqueó la salida del servidor. Se renueva sola en unos minutos: probá de nuevo más tarde.",
  login: "El video es privado o pide iniciar sesión.",
  unavailable: "El video no existe, lo borraron o no está disponible.",
  too_big: "El video es más grande que el máximo que bajo (8 GB).",
  unsupported: "No encontré un video en ese link.",
  unconvertible: "No pude convertir ese archivo a ese formato.",
  no_moment: "No encontré en el video lo que pediste. Si me decís el minuto, lo recorto igual.",
  timeout: "Tardó demasiado y lo corté.",
  cancelled: "Cancelada.",
  failed: "No pude bajarlo. Probá de nuevo en un rato.",
};

export const CONVERSION_SITE = "Transferencias";
const RETRYING = "YouTube bloqueó la salida del servidor; lo reintento solo en unos minutos.";
/** A blocked YouTube download waits for the tunnel to renew (checked every 15 minutes) and tries again, twice. */
const BLOCKED_RETRIES = 2;
const RETRY_MS = 15 * 60_000;
const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg" };
const FORMAT_NAMES: Record<MediaFormat, string> = { iphone: "para el iPhone", max: "en máxima calidad", mp3: "en MP3", m4a: "en M4A" };
const AUDIO_FORMATS: ReadonlySet<MediaFormat> = new Set(["mp3", "m4a"]);
const RECENT_MS = 3_600_000;
const PROGRESS_STEP = 0.01;

function toJob(row: Row): MediaJob {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    site: row.site,
    format: row.format,
    ...(row.send_json ? { send: JSON.parse(row.send_json) as SendRequest } : {}),
    ...(row.edit_json ? { edit: JSON.parse(row.edit_json) as EditSpec } : {}),
    ...(row.stage && row.status === "running" ? { stage: row.stage } : {}),
    status: row.status,
    progress: row.progress,
    attempts: row.attempts,
    ...(row.status === "queued" && row.not_before ? { retryAt: row.not_before } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    createdAt: row.created_at,
  };
}

/** A video title as a file name: symbols and emoji dropped, no trailing dots before the extension. */
export function titleForFile(title: string): string {
  const cleaned = title
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  return cleaned || "video";
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toLocaleString("es-AR", { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** How the sending went, for the owner's chat notice. */
function deliveryNote(send: SendRequest | undefined, sent: SendOutcome | undefined): string {
  if (!send || !sent) return "";
  const to = send.channel === "email" ? `por mail a ${send.name}` : `a ${send.name} por WhatsApp`;
  if (!sent.ok) return ` No pude mandárselo ${to}: ${sent.message}`;
  return sent.via === "file" ? ` Se lo mandé ${to}.` : ` Como pesa mucho, le mandé ${to} un link para bajarlo en calidad original.`;
}

/** The owner's notice for a cut: which parts, how long, and what happened to the whole video. Only numbers, never what the video says. */
function cutNote(job: MediaJob, moments: Moment[], transfer: Transfer, keptFull: boolean): string {
  const seconds = moments.reduce((total, moment) => total + moment.end - moment.start, 0);
  const [only] = moments;
  const parts = moments.length === 1 && only ? `del ${clock(only.start)} al ${clock(only.end)}` : `${moments.length} partes: ${moments.map((moment) => `${clock(moment.start)}–${clock(moment.end)}`).join(", ")}`;
  const whole =
    job.source === "transfer"
      ? job.edit?.keepSource
        ? ""
        : " Borré el original de Transferencias."
      : keptFull
        ? " También dejé el video entero."
        : " El video entero no lo guardé.";
  return `Terminé el recorte que pediste (${parts}; ${clock(seconds)} en total, ${megabytes(transfer.size)}): está en Transferencias.${whole}`;
}

/** What one job made, before it lands in Transferencias. */
interface Made {
  path: string;
  name: string;
  ext: string;
  /** The video's title, for the push notification only. */
  title: string;
  height?: number;
  origin: TransferOrigin;
  sender?: string;
  /** The parts a cut kept. */
  moments?: Moment[];
  /** The whole downloaded video, when the owner wanted to keep it too. */
  full?: { path: string; name: string; ext: string };
  /** The Transferencias file a cut came from, to drop when the owner did not want to keep it. */
  source?: Transfer;
}

export interface MediaQueueDeps {
  db: Db;
  store: TransferStore;
  downloader: MediaDownloader;
  converter?: MediaConverter;
  /** Sends a finished file to whoever the owner named with the request. */
  send?(transfer: Transfer, request: SendRequest): Promise<SendOutcome>;
  /** Removes a Transferencias file and its previews. */
  discard?(transfer: Transfer): void;
  /** Transferencias' folder: finished files land here; work in progress goes under `downloads/`. */
  dir: string;
  /** Free bytes on the disk; a job only starts with room to spare. */
  freeBytes(): number;
  now?(): Date;
}

/**
 * The owner's media jobs, one at a time: videos or songs downloaded from YouTube, X or Instagram,
 * and conversions of Transferencias files. Each result lands in Transferencias and can go straight to someone.
 */
export class MediaQueue {
  private readonly outbox: Outbox;
  private running: { id: string; controller: AbortController } | undefined;
  private stopping = false;
  private wake: NodeJS.Timeout | undefined;
  private finder: MomentFinder | undefined;

  constructor(private readonly deps: MediaQueueDeps) {
    this.outbox = new Outbox(deps.db);
  }

  /** Lets cuts find moments by what is said and seen; it needs the model, which starts after the queue. */
  useFinder(finder: MomentFinder): void {
    this.finder = finder;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Puts back in line what a restart interrupted and starts the queue. */
  resume(): void {
    this.deps.db.prepare("UPDATE media_jobs SET status = 'queued', progress = 0, updated_at = ? WHERE status = 'running'").run(this.now().toISOString());
    void this.pump();
  }

  /** Queues a download by link or by YouTube search; undefined when the link is not a YouTube, X or Instagram page. */
  download(input: { url?: string; search?: string; format: MediaFormat; send?: SendRequest }): MediaJob | undefined {
    if (input.search) return this.insert({ source: "search", target: input.search, site: "YouTube", format: input.format, send: input.send });
    const link = input.url ? siteOf(input.url) : undefined;
    if (!link) return undefined;
    return this.insert({ source: "link", target: link.url, site: link.site, format: input.format, send: input.send });
  }

  /** Queues the conversion of a Transferencias file; undefined when the file is gone. */
  convert(transferId: string, format: ConvertFormat, send?: SendRequest): MediaJob | undefined {
    if (!this.deps.store.get(transferId, this.now())) return undefined;
    return this.insert({ source: "transfer", target: transferId, site: CONVERSION_SITE, format, send });
  }

  /** Queues a cut of a video from a link, a YouTube search or Transferencias; undefined when the source is not valid. */
  edit(input: { url?: string; search?: string; transferId?: string; format: "iphone" | "mp3"; edit: EditSpec; send?: SendRequest }): MediaJob | undefined {
    const common = { format: input.format, send: input.send, edit: input.edit };
    if (input.transferId) return this.deps.store.get(input.transferId, this.now()) ? this.insert({ source: "transfer", target: input.transferId, site: CONVERSION_SITE, ...common }) : undefined;
    if (input.search) return this.insert({ source: "search", target: input.search, site: "YouTube", ...common });
    const link = input.url ? siteOf(input.url) : undefined;
    return link ? this.insert({ source: "link", target: link.url, site: link.site, ...common }) : undefined;
  }

  get(id: string): MediaJob | undefined {
    const row = this.deps.db.prepare("SELECT * FROM media_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : undefined;
  }

  /** What is waiting or running, and what ended in the last hour. */
  recent(): MediaJob[] {
    const since = new Date(this.now().getTime() - RECENT_MS).toISOString();
    const rows = this.deps.db
      .prepare("SELECT * FROM media_jobs WHERE status IN ('queued', 'running') OR updated_at > ? ORDER BY created_at DESC LIMIT 20")
      .all(since) as Row[];
    return rows.map(toJob);
  }

  /** Stops for a shutdown: what was running goes back in line, to start over after the restart. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.wake);
    this.running?.controller.abort();
    await this.idle();
  }

  cancel(id: string): boolean {
    if (this.running?.id === id) {
      this.running.controller.abort();
      return true;
    }
    return this.deps.db.prepare("UPDATE media_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(this.now().toISOString(), id).changes > 0;
  }

  /** Resolves once nothing is running; for tests. */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private insert(job: { source: JobSource; target: string; site: string; format: MediaFormat; send: SendRequest | undefined; edit?: EditSpec }): MediaJob | undefined {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.deps.db
      .prepare("INSERT INTO media_jobs (id, source, target, site, format, send_json, edit_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, job.source, job.target, job.site, job.format, job.send ? JSON.stringify(job.send) : null, job.edit ? JSON.stringify(job.edit) : null, at, at);
    void this.pump();
    return this.get(id);
  }

  private update(id: string, patch: { status?: JobStatus; progress?: number; error?: string; transferId?: string; stage?: string }): void {
    this.deps.db
      .prepare(
        "UPDATE media_jobs SET status = COALESCE(?, status), progress = COALESCE(?, progress), error = COALESCE(?, error), transfer_id = COALESCE(?, transfer_id), stage = COALESCE(?, stage), updated_at = ? WHERE id = ?",
      )
      .run(patch.status ?? null, patch.progress ?? null, patch.error ?? null, patch.transferId ?? null, patch.stage ?? null, this.now().toISOString(), id);
  }

  private retryLater(job: MediaJob): void {
    const at = this.now();
    this.deps.db
      .prepare("UPDATE media_jobs SET status = 'queued', progress = 0, attempts = attempts + 1, not_before = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(new Date(at.getTime() + RETRY_MS).toISOString(), RETRYING, at.toISOString(), job.id);
  }

  /** Wakes the queue when the next postponed job is due. */
  private wakeForRetry(): void {
    const next = this.deps.db.prepare("SELECT MIN(not_before) AS at FROM media_jobs WHERE status = 'queued' AND not_before IS NOT NULL").get() as { at: string | null };
    if (!next.at || this.stopping) return;
    clearTimeout(this.wake);
    this.wake = setTimeout(() => void this.pump(), Math.max(1000, Date.parse(next.at) - this.now().getTime()));
    this.wake.unref();
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopping) return;
    const row = this.deps.db
      .prepare("SELECT * FROM media_jobs WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at LIMIT 1")
      .get(this.now().toISOString()) as Row | undefined;
    if (!row) return this.wakeForRetry();
    const job = toJob(row);
    const controller = new AbortController();
    this.running = { id: job.id, controller };
    this.update(job.id, { status: "running", progress: 0 });
    const work = join(this.deps.dir, "downloads", job.id);
    try {
      if (this.deps.freeBytes() < 10 * 1024 ** 3) throw new DownloadError("too_big");
      mkdirSync(work, { recursive: true });
      let reported = 0;
      const onProgress = (fraction: number) => {
        if (fraction - reported < PROGRESS_STEP && fraction < 1) return;
        reported = fraction;
        this.update(job.id, { progress: fraction });
      };
      const made = job.edit
        ? await this.cutFile(job, job.edit, work, onProgress, controller.signal)
        : job.source === "transfer"
          ? await this.convertFile(job, work, onProgress, controller.signal)
          : await this.downloadFile(job, work, onProgress, controller.signal);
      const transfer = this.keep(job, made);
      if (made.full) this.keep({ ...job, id: `${job.id}-full` }, { ...made, ...made.full });
      if (made.source && !job.edit?.keepSource) this.deps.discard?.(made.source);
      this.update(job.id, { status: "done", progress: 1, transferId: transfer.id });
      const sent = job.send && this.deps.send ? await this.deps.send(transfer, job.send) : undefined;
      this.notifyDone(job, made, transfer, sent);
    } catch (error) {
      if (this.stopping) {
        this.update(job.id, { status: "queued", progress: 0 });
        return;
      }
      const reason = error instanceof DownloadError ? error.reason : "failed";
      if (reason === "blocked" && job.attempts < BLOCKED_RETRIES) {
        this.retryLater(job);
        return;
      }
      this.update(job.id, { status: reason === "cancelled" ? "cancelled" : "failed", error: FAILURES[reason] });
      if (reason !== "cancelled") this.notifyFailed(job, reason);
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.running = undefined;
      if (!this.stopping) void this.pump();
    }
  }

  private async downloadFile(job: MediaJob, work: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Made> {
    if (job.source === "transfer") throw new DownloadError("failed");
    const file = await this.deps.downloader.run({ source: job.source, target: job.target, site: job.site as Site, format: job.format }, work, onProgress, signal);
    return { path: file.path, name: `${titleForFile(file.title)}.${file.ext}`, ext: file.ext, title: file.title, ...(file.height ? { height: file.height } : {}), origin: "download", sender: job.site };
  }

  private async cutFile(job: MediaJob, edit: EditSpec, work: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Made> {
    const converter = this.deps.converter;
    if (!converter || (job.format !== "iphone" && job.format !== "mp3")) throw new DownloadError("unconvertible");
    const stage = (name: string, from: number, to: number) => {
      this.update(job.id, { stage: name, progress: from });
      return (fraction: number) => onProgress(from + fraction * (to - from));
    };
    const source = job.source === "transfer" ? this.deps.store.get(job.target, this.now()) : undefined;
    if (job.source === "transfer" && !source) throw new DownloadError("unavailable");
    const downloaded =
      job.source === "transfer"
        ? undefined
        : await this.deps.downloader.run({ source: job.source, target: job.target, site: job.site as Site, format: "iphone" }, work, stage("Bajando", 0, 0.5), signal);
    const input = source ? join(this.deps.dir, source.uploadId) : (downloaded?.path ?? "");
    const title = source ? source.name.slice(0, source.name.length - extname(source.name).length) : (downloaded?.title ?? "video");
    const duration = (await converter.probe(input).catch(() => ({ duration: 0 }))).duration;

    let moments = edit.segments?.map((moment) => ({ start: moment.start, end: Math.min(moment.end, duration || moment.end) })).filter((moment) => moment.end > moment.start) ?? [];
    if (edit.find) {
      if (!this.finder) throw new DownloadError("unconvertible");
      stage("Buscando el momento", 0.5, 0.8);
      moments = padded(await this.finder.find(input, duration, edit.find, work, signal), edit.padding, duration);
    }
    if (moments.length === 0) throw new DownloadError("no_moment");
    const cut = await converter.cut(input, moments, { format: job.format, vertical: edit.vertical }, work, stage("Recortando", 0.8, 1), signal);
    const name = `${titleForFile(title)} - recorte.${cut.ext}`;
    return {
      path: cut.path,
      name,
      ext: cut.ext,
      title: downloaded?.title ?? name,
      moments,
      origin: source?.origin ?? "download",
      ...(source?.sender ? { sender: source.sender } : downloaded ? { sender: job.site } : {}),
      ...(source ? { source } : {}),
      ...(downloaded && edit.keepSource ? { full: { path: downloaded.path, name: `${titleForFile(downloaded.title)}.${downloaded.ext}`, ext: downloaded.ext } } : {}),
    };
  }

  private async convertFile(job: MediaJob, work: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Made> {
    const source = this.deps.store.get(job.target, this.now());
    if (!source) throw new DownloadError("unavailable");
    if (!this.deps.converter || job.format === "max") throw new DownloadError("unconvertible");
    const file = await this.deps.converter.run(join(this.deps.dir, source.uploadId), job.format, work, onProgress, signal);
    const stem = titleForFile(source.name.slice(0, source.name.length - extname(source.name).length));
    const name = job.format === "iphone" ? `${stem} - iPhone.${file.ext}` : `${stem}.${file.ext}`;
    return { path: file.path, name, ext: file.ext, title: name, ...(file.height ? { height: file.height } : {}), origin: source.origin, ...(source.sender ? { sender: source.sender } : {}) };
  }

  private keep(job: MediaJob, made: Made): Transfer {
    const uploadId = `dl-${job.id}`;
    const path = join(this.deps.dir, uploadId);
    renameSync(made.path, path);
    return this.deps.store.add(
      { origin: made.origin, ...(made.sender ? { sender: made.sender } : {}), name: safeFileName(made.name), mediaType: MEDIA_TYPES[made.ext] ?? "application/octet-stream", size: statSync(path).size, uploadId },
      this.now(),
    );
  }

  private notifyDone(job: MediaJob, made: Made, transfer: Transfer, sent: SendOutcome | undefined): void {
    const details = [made.height ? `${made.height}p` : undefined, megabytes(transfer.size)].filter(Boolean).join(", ");
    const kind = AUDIO_FORMATS.has(job.format) ? "el audio" : "el video";
    const done = made.moments
      ? cutNote(job, made.moments, transfer, Boolean(made.full))
      : job.source === "transfer"
        ? `Terminé de convertir el archivo ${FORMAT_NAMES[job.format]} (${details}): está en Transferencias.`
        : `Terminé de bajar ${kind} de ${job.site} que pediste ${FORMAT_NAMES[job.format]} (${details}): está en Transferencias.`;
    const push = `Ya está «${made.title}»${job.send && sent?.ok ? ` y se lo mandé a ${job.send.name}` : ""}.`;
    this.notify(job, push, `${done}${deliveryNote(job.send, sent)}`);
  }

  private notifyFailed(job: MediaJob, reason: DownloadFailure): void {
    const what = job.edit
      ? "recortar el video"
      : job.source === "transfer"
        ? `convertir el archivo ${FORMAT_NAMES[job.format]}`
        : `bajar ${AUDIO_FORMATS.has(job.format) ? "el audio" : "el video"} de ${job.site}`;
    this.notify(job, `No pude ${what}.`, `No pude ${what} que pediste. ${FAILURES[reason]}`);
  }

  private notify(job: MediaJob, push: string, chat: string): void {
    const at = this.now();
    this.outbox.enqueue({ kind: "push", dedupeKey: `download:${job.id}:push`, payload: { title: NOTIFICATION_TITLE, body: push, tag: `download:${job.id}`, url: "/transferencias" } }, at);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `download:${job.id}:chat`, payload: { text: chat, cards: [] } }, at);
  }
}
