import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE } from "../push/notification.js";
import { safeFileName } from "../tasks/workspace.js";
import type { TransferStore } from "../transfers/transfer-store.js";
import { Outbox } from "../worker/outbox.js";
import { DownloadError, siteOf, type DownloadFailure, type MediaDownloader, type Quality, type Site } from "./media-downloader.js";

export type DownloadStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface MediaDownload {
  id: string;
  url: string;
  site: Site;
  quality: Quality;
  status: DownloadStatus;
  progress: number;
  error?: string;
  transferId?: string;
  createdAt: string;
}

interface Row {
  id: string;
  url: string;
  site: Site;
  quality: Quality;
  status: DownloadStatus;
  progress: number;
  error: string | null;
  transfer_id: string | null;
  created_at: string;
}

/** What the owner reads when a download fails; the raw tool output never reaches them or the model. */
export const FAILURES: Record<DownloadFailure, string> = {
  blocked: "YouTube bloquea las descargas desde tu servidor. Falta configurarle otra salida a internet; pedíselo a quien mantiene Jarvis.",
  login: "El video es privado o pide iniciar sesión.",
  unavailable: "El video no existe, lo borraron o no está disponible.",
  too_big: "El video es más grande que el máximo que bajo (8 GB).",
  unsupported: "No encontré un video en ese link.",
  timeout: "La descarga tardó demasiado y la corté.",
  cancelled: "Cancelada.",
  failed: "No pude bajarlo. Probá de nuevo en un rato.",
};

const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg" };
const RECENT_MS = 3_600_000;
const PROGRESS_STEP = 0.01;

function toDownload(row: Row): MediaDownload {
  return {
    id: row.id,
    url: row.url,
    site: row.site,
    quality: row.quality,
    status: row.status,
    progress: row.progress,
    ...(row.error ? { error: row.error } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    createdAt: row.created_at,
  };
}

/** A video title as a file name: no emoji or symbols, no trailing dots before the extension. */
export function titleForFile(title: string): string {
  const cleaned = title
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  return cleaned || "video";
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toLocaleString("es-AR", { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export interface DownloadQueueDeps {
  db: Db;
  store: TransferStore;
  downloader: MediaDownloader;
  /** Transferencias' folder: finished files land here; work in progress goes under `downloads/`. */
  dir: string;
  /** Free bytes on the disk; a download only starts with room to spare. */
  freeBytes(): number;
  now?(): Date;
}

/** Owner-requested videos from YouTube, X or Instagram, downloaded one at a time into Transferencias. */
export class DownloadQueue {
  private readonly outbox: Outbox;
  private running: { id: string; controller: AbortController } | undefined;

  constructor(private readonly deps: DownloadQueueDeps) {
    this.outbox = new Outbox(deps.db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Puts back in line what a restart interrupted and starts the queue. */
  resume(): void {
    this.deps.db.prepare("UPDATE media_downloads SET status = 'queued', progress = 0, updated_at = ? WHERE status = 'running'").run(this.now().toISOString());
    void this.pump();
  }

  /** Queues a link; undefined when it is not a YouTube, X or Instagram page. */
  add(input: string, quality: Quality = "max"): MediaDownload | undefined {
    const link = siteOf(input);
    if (!link) return undefined;
    const id = randomUUID();
    const at = this.now().toISOString();
    this.deps.db
      .prepare("INSERT INTO media_downloads (id, url, site, quality, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
      .run(id, link.url, link.site, quality, at, at);
    void this.pump();
    return this.get(id);
  }

  get(id: string): MediaDownload | undefined {
    const row = this.deps.db.prepare("SELECT * FROM media_downloads WHERE id = ?").get(id) as Row | undefined;
    return row ? toDownload(row) : undefined;
  }

  /** What is waiting or running, and what ended in the last hour. */
  recent(): MediaDownload[] {
    const since = new Date(this.now().getTime() - RECENT_MS).toISOString();
    const rows = this.deps.db
      .prepare("SELECT * FROM media_downloads WHERE status IN ('queued', 'running') OR updated_at > ? ORDER BY created_at DESC LIMIT 20")
      .all(since) as Row[];
    return rows.map(toDownload);
  }

  cancel(id: string): boolean {
    if (this.running?.id === id) {
      this.running.controller.abort();
      return true;
    }
    return this.deps.db.prepare("UPDATE media_downloads SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(this.now().toISOString(), id).changes > 0;
  }

  /** Resolves once nothing is running; for tests. */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private update(id: string, patch: { status?: DownloadStatus; progress?: number; error?: string; transferId?: string }): void {
    this.deps.db
      .prepare(
        "UPDATE media_downloads SET status = COALESCE(?, status), progress = COALESCE(?, progress), error = COALESCE(?, error), transfer_id = COALESCE(?, transfer_id), updated_at = ? WHERE id = ?",
      )
      .run(patch.status ?? null, patch.progress ?? null, patch.error ?? null, patch.transferId ?? null, this.now().toISOString(), id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const row = this.deps.db.prepare("SELECT * FROM media_downloads WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Row | undefined;
    if (!row) return;
    const job = toDownload(row);
    const controller = new AbortController();
    this.running = { id: job.id, controller };
    this.update(job.id, { status: "running", progress: 0 });
    const work = join(this.deps.dir, "downloads", job.id);
    try {
      if (this.deps.freeBytes() < 10 * 1024 ** 3) throw new DownloadError("too_big");
      mkdirSync(work, { recursive: true });
      let reported = 0;
      const file = await this.deps.downloader.run(job, work, (fraction) => {
        if (fraction - reported < PROGRESS_STEP && fraction < 1) return;
        reported = fraction;
        this.update(job.id, { progress: fraction });
      }, controller.signal);
      const uploadId = `dl-${job.id}`;
      renameSync(file.path, join(this.deps.dir, uploadId));
      const size = statSync(join(this.deps.dir, uploadId)).size;
      const transfer = this.deps.store.add(
        { origin: "download", sender: job.site, name: safeFileName(`${titleForFile(file.title)}.${file.ext}`), mediaType: MEDIA_TYPES[file.ext] ?? "application/octet-stream", size, uploadId },
        this.now(),
      );
      this.update(job.id, { status: "done", progress: 1, transferId: transfer.id });
      this.notify(job, `Ya está «${file.title}» de ${job.site}${file.height ? ` (${file.height}p)` : ""}.`, `Terminé de bajar el video de ${job.site} que pediste${file.height ? ` (${file.height}p, ${megabytes(size)})` : ` (${megabytes(size)})`}: está en Transferencias, en su calidad original.`);
    } catch (error) {
      const reason = error instanceof DownloadError ? error.reason : "failed";
      this.update(job.id, { status: reason === "cancelled" ? "cancelled" : "failed", error: FAILURES[reason] });
      if (reason !== "cancelled") this.notify(job, `No pude bajar el video de ${job.site}.`, `No pude bajar el video de ${job.site} que pediste. ${FAILURES[reason]}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
      this.running = undefined;
      void this.pump();
    }
  }

  private notify(job: MediaDownload, push: string, chat: string): void {
    const at = this.now();
    this.outbox.enqueue({ kind: "push", dedupeKey: `download:${job.id}:push`, payload: { title: NOTIFICATION_TITLE, body: push, tag: `download:${job.id}`, url: "/transferencias" } }, at);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `download:${job.id}:chat`, payload: { text: chat, cards: [] } }, at);
  }
}
