import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";
import { normalizeText } from "./normalize.js";

export const DEDUPE_WINDOW_MS = 60_000;

export type ReminderStatus = "scheduled" | "fired" | "cancelled" | "missed";

export interface Reminder {
  id: string;
  text: string;
  dueUtc: string;
  timezone: string;
  rrule: string | null;
  sensitive: boolean;
  status: ReminderStatus;
  lastFiredUtc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewReminder {
  text: string;
  dueUtc: string;
  timezone: string;
  rrule?: string;
  sensitive?: boolean;
  turnId?: string;
}

export interface ReminderChanges {
  text?: string;
  dueUtc?: string;
  rrule?: string | null;
  status?: ReminderStatus;
}

export interface ReminderFilter {
  status: ReminderStatus;
  fromUtc?: string;
  toUtc?: string;
}

export interface ReminderRow {
  id: string;
  text: string;
  due_utc: string;
  timezone: string;
  rrule: string | null;
  sensitive: number;
  status: ReminderStatus;
  last_fired_utc: string | null;
  created_at: string;
  updated_at: string;
}

export function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    text: row.text,
    dueUtc: row.due_utc,
    timezone: row.timezone,
    rrule: row.rrule,
    sensitive: row.sensitive === 1,
    status: row.status,
    lastFiredUtc: row.last_fired_utc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shift(utcIso: string, ms: number): string {
  return new Date(Date.parse(utcIso) + ms).toISOString();
}

/** Reminders the owner asked for. The worker process fires them; this store only manages them. */
export class ReminderStore {
  constructor(private readonly db: Db) {}

  get(id: string): Reminder | undefined {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as ReminderRow | undefined;
    return row ? toReminder(row) : undefined;
  }

  /** An active reminder with the same normalized text due within a minute of `dueUtc`. */
  findDuplicate(text: string, dueUtc: string): Reminder | undefined {
    const target = normalizeText(text);
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'scheduled' AND due_utc BETWEEN ? AND ? ORDER BY created_at")
      .all(shift(dueUtc, -DEDUPE_WINDOW_MS), shift(dueUtc, DEDUPE_WINDOW_MS)) as ReminderRow[];
    const row = rows.find((candidate) => normalizeText(candidate.text) === target);
    return row ? toReminder(row) : undefined;
  }

  /** Creates the reminder unless a near-identical active one exists, which is returned instead. */
  create(input: NewReminder, now = new Date()): { reminder: Reminder; duplicate: boolean } {
    return this.db.transaction(() => {
      const existing = this.findDuplicate(input.text, input.dueUtc);
      if (existing) return { reminder: existing, duplicate: true };
      const id = randomUUID();
      const at = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO reminders (id, text, due_utc, timezone, rrule, sensitive, status, created_turn_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
        )
        .run(id, input.text, input.dueUtc, input.timezone, input.rrule ?? null, input.sensitive ? 1 : 0, input.turnId ?? null, at, at);
      return { reminder: this.get(id) as Reminder, duplicate: false };
    }).immediate();
  }

  update(id: string, changes: ReminderChanges, now = new Date()): Reminder | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.db
      .prepare("UPDATE reminders SET text = ?, due_utc = ?, rrule = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(
        changes.text ?? existing.text,
        changes.dueUtc ?? existing.dueUtc,
        changes.rrule !== undefined ? changes.rrule : existing.rrule,
        changes.status ?? existing.status,
        now.toISOString(),
        id,
      );
    return this.get(id);
  }

  /** Cancels a scheduled or missed reminder. Returns undefined when it is in any other state. */
  cancel(id: string, now = new Date()): Reminder | undefined {
    const result = this.db
      .prepare("UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'missed')")
      .run(now.toISOString(), id);
    return result.changes > 0 ? this.get(id) : undefined;
  }

  list(filter: ReminderFilter, limit: number): { reminders: Reminder[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = @status AND (@fromUtc IS NULL OR due_utc >= @fromUtc) AND (@toUtc IS NULL OR due_utc <= @toUtc)
         ORDER BY due_utc LIMIT @limit`,
      )
      .all({ status: filter.status, fromUtc: filter.fromUtc ?? null, toUtc: filter.toUtc ?? null, limit: limit + 1 }) as ReminderRow[];
    return { reminders: rows.slice(0, limit).map(toReminder), hasMore: rows.length > limit };
  }
}
