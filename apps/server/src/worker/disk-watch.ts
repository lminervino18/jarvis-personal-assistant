import { statfsSync } from "node:fs";
import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE } from "../push/notification.js";
import { Outbox } from "./outbox.js";

export const DISK_WARN_RATIO = 0.8;
const CHECK_EVERY_MS = 3_600_000;
const GB = 1024 ** 3;

export interface DiskUsage {
  /** Share of the disk in use, as `df` reports it (0 to 1). */
  ratio: number;
  freeBytes: number;
}

/** How full the filesystem holding `path` is. */
export function readDiskUsage(path: string): DiskUsage {
  const stats = statfsSync(path);
  const used = stats.blocks - stats.bfree;
  return { ratio: used / (used + stats.bavail), freeBytes: stats.bavail * stats.bsize };
}

/**
 * Checks the server's disk once an hour and, while it is 80 % full or more, tells the owner once a
 * day by push and in the chat. A full disk stops the database from saving messages and deploys from building.
 */
export class DiskWatch {
  private readonly outbox: Outbox;
  private lastCheck = Number.NEGATIVE_INFINITY;

  constructor(
    db: Db,
    private readonly read: () => DiskUsage,
  ) {
    this.outbox = new Outbox(db);
  }

  /** The usage when it was checked and is over the limit; undefined otherwise. */
  check(now: Date): DiskUsage | undefined {
    if (now.getTime() - this.lastCheck < CHECK_EVERY_MS) return undefined;
    this.lastCheck = now.getTime();
    const usage = this.read();
    if (usage.ratio < DISK_WARN_RATIO) return undefined;
    const percent = Math.round(usage.ratio * 100);
    const free = Math.floor(usage.freeBytes / GB);
    const day = now.toISOString().slice(0, 10);
    const text = `El disco del servidor está al ${percent} % (quedan ${free} GB). Si se llena no puedo guardar mensajes ni publicar cambios: hay que liberar espacio (docs/runbook.md, «Disk filling»).`;
    this.outbox.enqueue({ kind: "push", dedupeKey: `disk:${day}:push`, payload: { title: NOTIFICATION_TITLE, body: `Disco del servidor al ${percent} %: quedan ${free} GB.`, tag: "disk", url: "/" } }, now);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `disk:${day}:chat`, payload: { text, cards: [] } }, now);
    return usage;
  }
}
