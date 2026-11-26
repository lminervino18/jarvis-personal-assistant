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

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
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
    status: row.status,
    progress: row.progress,
    attempts: row.attempts,
    ...(row.status === "queued" && row.not_before ? { retryAt: row.not_before } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    createdAt: row.created_at,
  };
}

/** A video title as a file name: no emoji or symbols, no trailing dots before the extension. */
export function titleForFile(title: string): string {
  const cleaned = title
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
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
}

export interface MediaQueueDeps {
  db: Db;
  store: TransferStore;
  downloader: MediaDownloader;
  converter?: MediaConverter;
  /** Sends a finished file to whoever the owner named with the request. */
  send?(transfer: Transfer, request: SendRequest): Promise<SendOutcome>;
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

  constructor(private readonly deps: MediaQueueDeps) {
    this.outbox = new Outbox(deps.db);
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

  private insert(job: { source: JobSource; target: string; site: string; format: MediaFormat; send: SendRequest | undefined }): MediaJob | undefined {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.deps.db
      .prepare("INSERT INTO media_jobs (id, source, target, site, format, send_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, job.source, job.target, job.site, job.format, job.send ? JSON.stringify(job.send) : null, at, at);
    void this.pump();
    return this.get(id);
  }

  private update(id: string, patch: { status?: JobStatus; progress?: number; error?: string; transferId?: string }): void {
    this.deps.db
      .prepare(
        "UPDATE media_jobs SET status = COALESCE(?, status), progress = COALESCE(?, progress), error = COALESCE(?, error), transfer_id = COALESCE(?, transfer_id), updated_at = ? WHERE id = ?",
      )
      .run(patch.status ?? null, patch.progress ?? null, patch.error ?? null, patch.transferId ?? null, this.now().toISOString(), id);
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
      const made = job.source === "transfer" ? await this.convertFile(job, work, onProgress, controller.signal) : await this.downloadFile(job, work, onProgress, controller.signal);
      const transfer = this.keep(job, made);
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

  private async convertFile(job: MediaJob, work: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<Made> {
    const source = this.deps.store.get(job.target, this.now());
    if (!source) throw new DownloadError("unavailable");
    if (!this.deps.converter || job.format === "max") throw new DownloadError("unconvertible");
    const file = await this.deps.converter.run(join(this.deps.dir, source.uploadId), job.format, work, onProgress, signal);
    const stem = source.name.slice(0, source.name.length - extname(source.name).length) || "archivo";
    const name = job.format === "iphone" ? `${stem} (iPhone).${file.ext}` : `${stem}.${file.ext}`;
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
    const done =
      job.source === "transfer"
        ? `Terminé de convertir el archivo ${FORMAT_NAMES[job.format]} (${details}): está en Transferencias.`
        : `Terminé de bajar ${kind} de ${job.site} que pediste ${FORMAT_NAMES[job.format]} (${details}): está en Transferencias.`;
    const push = `Ya está «${made.title}»${job.send && sent?.ok ? ` y se lo mandé a ${job.send.name}` : ""}.`;
    this.notify(job, push, `${done}${deliveryNote(job.send, sent)}`);
  }

  private notifyFailed(job: MediaJob, reason: DownloadFailure): void {
    const what = job.source === "transfer" ? `convertir el archivo ${FORMAT_NAMES[job.format]}` : `bajar ${AUDIO_FORMATS.has(job.format) ? "el audio" : "el video"} de ${job.site}`;
    this.notify(job, `No pude ${what}.`, `No pude ${what} que pediste. ${FAILURES[reason]}`);
  }

  private notify(job: MediaJob, push: string, chat: string): void {
    const at = this.now();
    this.outbox.enqueue({ kind: "push", dedupeKey: `download:${job.id}:push`, payload: { title: NOTIFICATION_TITLE, body: push, tag: `download:${job.id}`, url: "/transferencias" } }, at);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `download:${job.id}:chat`, payload: { text: chat, cards: [] } }, at);
  }
}
