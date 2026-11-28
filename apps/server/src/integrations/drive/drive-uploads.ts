import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GmailAccountLabel } from "@jarvis/contracts";
import type { Db } from "../../db/database.js";
import { NOTIFICATION_TITLE } from "../../push/notification.js";
import type { TransferStore } from "../../transfers/transfer-store.js";
import { Outbox } from "../../worker/outbox.js";
import { DriveError, type DriveClient } from "./drive-client.js";

/** Bytes sent per request; Drive wants multiples of 256 KiB. */
export const CHUNK_BYTES = 32 * 1024 * 1024;
const SAMPLE_BYTES = 8 * 1024 * 1024;
const RETRY_MINUTES = [1, 5, 15, 60, 180];
const POLL_MS = 60_000;

type Status = "queued" | "running" | "done" | "failed" | "cancelled";

export interface DriveUpload {
  id: string;
  name: string;
  size: number;
  status: Status;
  progress: number;
  folderPath?: string;
  link?: string;
  /** It was already in that folder, so nothing was uploaded again. */
  duplicate: boolean;
  error?: string;
  retryAt?: string;
  createdAt: string;
}

interface Row {
  id: string;
  account: GmailAccountLabel;
  transfer_id: string | null;
  name: string;
  media_type: string;
  size: number;
  folder_id: string | null;
  folder_path: string | null;
  session_url: string | null;
  status: Status;
  progress: number;
  attempts: number;
  not_before: string | null;
  error: string | null;
  drive_file_id: string | null;
  link: string | null;
  duplicate: number;
  created_at: string;
}

export interface DriveUploadsDeps {
  db: Db;
  client: DriveClient;
  store: TransferStore;
  /** Where Transferencias keeps its files. */
  transfersDir: string;
  /** Where each upload keeps its own hard link to the file, so it outlives the 24-hour transfer. */
  dir: string;
  now?: () => Date;
  chunkBytes?: number;
}

function toUpload(row: Row): DriveUpload {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    status: row.status,
    progress: row.progress,
    ...(row.folder_path ? { folderPath: row.folder_path } : {}),
    ...(row.link ? { link: row.link } : {}),
    duplicate: row.duplicate === 1,
    ...(row.error ? { error: row.error } : {}),
    ...(row.status === "queued" && row.not_before ? { retryAt: row.not_before } : {}),
    createdAt: row.created_at,
  };
}

/** A key for a file's content: its size plus a hash of its first and last 8 MB, cheap even for a whole match. */
export function contentKey(path: string, size: number): string {
  const hash = createHash("sha256").update(String(size));
  const fd = openSync(path, "r");
  try {
    for (const start of size > 2 * SAMPLE_BYTES ? [0, size - SAMPLE_BYTES] : [0]) {
      const buffer = Buffer.alloc(Math.min(size > 2 * SAMPLE_BYTES ? SAMPLE_BYTES : size, size));
      readSync(fd, buffer, 0, buffer.length, start);
      hash.update(buffer);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex").slice(0, 40);
}

function readChunk(path: string, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/**
 * Uploads files from Transferencias to Drive in the background, one at a time, with Drive's
 * resumable protocol: a dropped connection, a deploy or a restart resumes where it stopped.
 * Skips a file already uploaded to the same folder, retries failures with growing waits, and
 * tells the owner with the link when it ends. The chat message never carries the file name,
 * which may come from a third party.
 */
export class DriveUploads {
  private readonly outbox: Outbox;
  private running: string | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: DriveUploadsDeps) {
    this.outbox = new Outbox(deps.db);
    mkdirSync(deps.dir, { recursive: true });
  }

  /** Puts back in line what a restart interrupted and starts working. */
  start(): void {
    this.deps.db.prepare("UPDATE drive_uploads SET status = 'queued' WHERE status = 'running'").run();
    this.timer = setInterval(() => void this.pump(), POLL_MS);
    this.timer.unref();
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Queues one Transferencias file for Drive; undefined when the transfer no longer exists. */
  enqueue(input: { account: GmailAccountLabel; transferId: string; folderId?: string; folderPath?: string; name?: string }): DriveUpload | undefined {
    const transfer = this.deps.store.get(input.transferId, this.now());
    if (!transfer) return undefined;
    const id = randomUUID();
    const source = join(this.deps.transfersDir, transfer.uploadId);
    if (!existsSync(source)) return undefined;
    try {
      linkSync(source, join(this.deps.dir, id));
    } catch {
      copyFileSync(source, join(this.deps.dir, id));
    }
    const at = this.now().toISOString();
    this.deps.db
      .prepare(
        "INSERT INTO drive_uploads (id, account, transfer_id, name, media_type, size, folder_id, folder_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
      )
      .run(id, input.account, transfer.id, input.name?.trim() || transfer.name, transfer.mediaType, transfer.size, input.folderId ?? null, input.folderPath?.trim() || null, at, at);
    void this.pump();
    return this.get(id);
  }

  get(id: string): DriveUpload | undefined {
    const row = this.deps.db.prepare("SELECT * FROM drive_uploads WHERE id = ?").get(id) as Row | undefined;
    return row ? toUpload(row) : undefined;
  }

  recent(limit = 10): DriveUpload[] {
    return (this.deps.db.prepare("SELECT * FROM drive_uploads ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toUpload);
  }

  /** Resolves once nothing is running; for tests. */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private set(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    this.deps.db
      .prepare(`UPDATE drive_uploads SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => fields[key] ?? null), this.now().toISOString(), id);
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopping) return;
    const row = this.deps.db
      .prepare("SELECT * FROM drive_uploads WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY created_at LIMIT 1")
      .get(this.now().toISOString()) as Row | undefined;
    if (!row) return;
    this.running = row.id;
    this.set(row.id, { status: "running" });
    try {
      await this.upload(row);
    } catch (error) {
      this.failed(row, error);
    } finally {
      this.running = undefined;
      if (!this.stopping) void this.pump();
    }
  }

  private async upload(row: Row): Promise<void> {
    const { client } = this.deps;
    const path = join(this.deps.dir, row.id);
    if (!existsSync(path)) throw new DriveError("rejected", "El archivo ya no estaba en el servidor.");
    const parent = row.folder_id ?? (await client.root(row.account)).id;
    const folder = row.folder_path ? (await client.folderAt(row.account, parent, row.folder_path)).id : parent;
    let session = row.session_url;
    if (!session) {
      const key = contentKey(path, row.size);
      const existing = await client.findUploaded(row.account, folder, key);
      if (existing) return this.finished(row, existing.id, existing.webViewLink, true);
      session = await client.startResumable(row.account, { name: row.name, mimeType: row.media_type, size: row.size, parent: folder, key });
      this.set(row.id, { session_url: session });
    }
    let state = await client.sendChunk(row.account, session, Buffer.alloc(0), 0, row.size).catch((error: unknown) => {
      if (error instanceof DriveError && (error.reason === "not_found" || error.reason === "rejected")) {
        this.set(row.id, { session_url: null });
        throw new DriveError("unavailable", "La subida venció en Drive; la empiezo de nuevo.");
      }
      throw error;
    });
    while ("received" in state) {
      if (this.stopping) throw new DriveError("unavailable", "El servidor se reinició.");
      const start = state.received;
      const chunk = readChunk(path, start, Math.min(this.deps.chunkBytes ?? CHUNK_BYTES, row.size - start));
      state = await client.sendChunk(row.account, session, chunk, start, row.size);
      if ("received" in state) this.set(row.id, { progress: state.received / row.size });
    }
    this.finished(row, state.done.id, state.done.webViewLink, false);
  }

  private finished(row: Row, fileId: string, link: string | undefined, duplicate: boolean): void {
    const url = link ?? `https://drive.google.com/file/d/${fileId}/view`;
    this.set(row.id, { status: "done", progress: 1, drive_file_id: fileId, link: url, duplicate: duplicate ? 1 : 0, error: null, session_url: null });
    rmSync(join(this.deps.dir, row.id), { force: true });
    const where = row.folder_path ? ` en la carpeta ${row.folder_path}` : "";
    const text = duplicate ? `El archivo que pediste ya estaba en Drive${where}, no lo subí de nuevo: ${url}` : `Terminé de subir a Drive el archivo que pediste${where}: ${url}`;
    this.notify(row, duplicate ? "Ya estaba en Drive." : "Subida a Drive terminada.", text);
  }

  private failed(row: Row, error: unknown): void {
    const reason = error instanceof DriveError ? error : new DriveError("unavailable", "Drive no respondió.");
    const fresh = this.deps.db.prepare("SELECT attempts FROM drive_uploads WHERE id = ?").get(row.id) as { attempts: number };
    if (reason.reason === "unavailable" && !this.stopping && fresh.attempts < RETRY_MINUTES.length) {
      const at = new Date(this.now().getTime() + (RETRY_MINUTES[fresh.attempts] ?? 60) * 60_000).toISOString();
      this.set(row.id, { status: "queued", attempts: fresh.attempts + 1, not_before: at, error: reason.message });
      return;
    }
    if (this.stopping) {
      this.set(row.id, { status: "queued" });
      return;
    }
    this.set(row.id, { status: "failed", error: reason.message });
    rmSync(join(this.deps.dir, row.id), { force: true });
    this.notify(row, "No pude subir un archivo a Drive.", `No pude subir a Drive el archivo que pediste. ${reason.message}`);
  }

  private notify(row: Row, push: string, chat: string): void {
    const at = this.now();
    this.outbox.enqueue({ kind: "push", dedupeKey: `drive-upload:${row.id}:push`, payload: { title: NOTIFICATION_TITLE, body: push, tag: `drive-upload:${row.id}`, url: "/transferencias" } }, at);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `drive-upload:${row.id}:chat`, payload: { text: chat, cards: [] } }, at);
  }
}
