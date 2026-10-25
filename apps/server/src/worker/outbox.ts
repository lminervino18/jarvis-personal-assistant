import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

export type OutboxKind = "push" | "chat_message";

export const MAX_ATTEMPTS = 6;
export const LEASE_MS = 120_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

export interface NewOutboxEntry {
  kind: OutboxKind;
  dedupeKey: string;
  payload: unknown;
}

/** An entry this worker holds under a lease. Completing it is only possible while the lease is still its own. */
export interface ClaimedEntry {
  id: string;
  kind: OutboxKind;
  payloadJson: string;
  attempts: number;
  lease: string;
}

interface OutboxRow {
  id: string;
  kind: OutboxKind;
  payload_json: string;
  attempts: number;
}

export interface OutboxCounts {
  pending: number;
  sending: number;
  dead: number;
}

/** Delay before the next try after `attempts` failed attempts: 30 s, 1 min, 2 min, ... capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

function shift(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

/** Durable delivery queue shared by every worker process. Entries are unique by dedupe key. */
export class Outbox {
  constructor(private readonly db: Db) {}

  /** Adds an entry unless one with the same dedupe key exists. Returns whether it was added. */
  enqueue(entry: NewOutboxEntry, now: Date): boolean {
    const at = now.toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, kind, dedupe_key, payload_json, status, next_attempt_utc, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(randomUUID(), entry.kind, entry.dedupeKey, JSON.stringify(entry.payload), at, at);
    return result.changes > 0;
  }

  /**
   * Leases the next deliverable entry: a pending one that is due, or one whose previous holder
   * crashed and let its lease expire. Entries that already used every attempt become dead instead.
   */
  claim(now: Date): ClaimedEntry | undefined {
    return this.db
      .transaction(() => {
        const at = now.toISOString();
        for (;;) {
          const row = this.db
            .prepare(
              `SELECT id, kind, payload_json, attempts FROM outbox
               WHERE (status = 'pending' AND next_attempt_utc <= @at) OR (status = 'sending' AND locked_until_utc <= @at)
               ORDER BY next_attempt_utc, created_at LIMIT 1`,
            )
            .get({ at }) as OutboxRow | undefined;
          if (!row) return undefined;
          if (row.attempts >= MAX_ATTEMPTS) {
            this.db.prepare("UPDATE outbox SET status = 'dead', locked_until_utc = NULL, last_error = 'lease_expired' WHERE id = ?").run(row.id);
            continue;
          }
          const lease = shift(now, LEASE_MS);
          this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1, locked_until_utc = ? WHERE id = ?").run(lease, row.id);
          return { id: row.id, kind: row.kind, payloadJson: row.payload_json, attempts: row.attempts + 1, lease };
        }
      })
      .immediate();
  }

  /** Marks the entry delivered. Returns false when the lease was lost, in which case nothing changed. */
  markSent(entry: ClaimedEntry, now: Date, note?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox SET status = 'sent', sent_at = ?, locked_until_utc = NULL, last_error = COALESCE(?, last_error)
         WHERE id = ? AND status = 'sending' AND locked_until_utc = ?`,
      )
      .run(now.toISOString(), note ?? null, entry.id, entry.lease);
    return result.changes > 0;
  }

  /** Schedules a retry with exponential backoff, or buries the entry once it is permanent or out of attempts. */
  markFailed(entry: ClaimedEntry, error: string, now: Date, permanent = false): "retry" | "dead" | "lost" {
    const dead = permanent || entry.attempts >= MAX_ATTEMPTS;
    const result = this.db
      .prepare(
        `UPDATE outbox SET status = ?, next_attempt_utc = ?, locked_until_utc = NULL, last_error = ?
         WHERE id = ? AND status = 'sending' AND locked_until_utc = ?`,
      )
      .run(dead ? "dead" : "pending", shift(now, backoffMs(entry.attempts)), error, entry.id, entry.lease);
    if (result.changes === 0) return "lost";
    return dead ? "dead" : "retry";
  }

  counts(): OutboxCounts {
    const rows = this.db.prepare("SELECT status, count(*) AS n FROM outbox GROUP BY status").all() as { status: string; n: number }[];
    const countOf = (status: string) => rows.find((row) => row.status === status)?.n ?? 0;
    return { pending: countOf("pending"), sending: countOf("sending"), dead: countOf("dead") };
  }
}
