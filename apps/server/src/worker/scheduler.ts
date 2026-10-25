import { createHash } from "node:crypto";
import type { Db } from "../db/database.js";
import { nextOccurrence } from "../agenda/recurrence.js";
import { toReminder, type Reminder, type ReminderRow } from "../agenda/reminders-store.js";
import { missedRemindersNotification, reminderNotification } from "../push/notification.js";
import { missedRemindersMessage, reminderMessage } from "./chat-messages.js";
import { Outbox } from "./outbox.js";

export const DEFAULT_GRACE_MINUTES = 360;
const LATE_AFTER_MS = 120_000;

export interface TickResult {
  fired: number;
  late: number;
  missed: number;
}

export interface SchedulerOptions {
  graceMs: number;
}

/**
 * Turns due reminders into outbox entries. Each tick claims every due reminder in one
 * `BEGIN IMMEDIATE` transaction, so concurrent workers and restarts fire each occurrence once.
 *
 * Downtime policy: a reminder overdue by no more than the grace window (`REMINDER_GRACE_MINUTES`)
 * fires once, flagged as late when it is more than two minutes overdue. One overdue by more than that
 * is not fired: a one-off becomes `missed`, a recurring one skips to its next occurrence, and all of
 * them together produce a single digest notification and chat message. The first tick after a
 * restart applies the same rule, which is how recovery works.
 */
export class ReminderScheduler {
  private readonly outbox: Outbox;

  constructor(
    private readonly db: Db,
    private readonly options: SchedulerOptions,
  ) {
    this.outbox = new Outbox(db);
  }

  tick(now: Date): TickResult {
    return this.db.transaction(() => this.claimDue(now)).immediate();
  }

  private claimDue(now: Date): TickResult {
    const due = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'scheduled' AND due_utc <= ? ORDER BY due_utc, id")
      .all(now.toISOString()) as ReminderRow[];
    const result = { fired: 0, late: 0, missed: [] as Reminder[] };
    for (const reminder of due.map(toReminder)) {
      const overdueMs = now.getTime() - Date.parse(reminder.dueUtc);
      const lapsed = overdueMs > this.options.graceMs;
      if (!this.advance(reminder, lapsed, now)) continue;
      if (lapsed) {
        result.missed.push(reminder);
        continue;
      }
      this.fire(reminder, overdueMs > LATE_AFTER_MS, now);
      result.fired++;
      if (overdueMs > LATE_AFTER_MS) result.late++;
    }
    if (result.missed.length > 0) this.enqueueDigest(result.missed, now);
    return { fired: result.fired, late: result.late, missed: result.missed.length };
  }

  private advance(reminder: Reminder, lapsed: boolean, now: Date): boolean {
    const next = this.nextDue(reminder, now);
    const status = next ? "scheduled" : lapsed ? "missed" : "fired";
    const result = this.db
      .prepare(
        `UPDATE reminders SET due_utc = ?, status = ?, last_fired_utc = ?, updated_at = ?
         WHERE id = ? AND status = 'scheduled' AND due_utc = ?`,
      )
      .run(next ?? reminder.dueUtc, status, lapsed ? reminder.lastFiredUtc : now.toISOString(), now.toISOString(), reminder.id, reminder.dueUtc);
    return result.changes > 0;
  }

  private nextDue(reminder: Reminder, now: Date): string | undefined {
    if (!reminder.rrule) return undefined;
    const after = new Date(now.getTime() + 1).toISOString();
    try {
      return nextOccurrence({ startUtc: reminder.dueUtc, timezone: reminder.timezone, rule: reminder.rrule }, after);
    } catch {
      return undefined;
    }
  }

  private fire(reminder: Reminder, late: boolean, now: Date): void {
    const key = `reminder:${reminder.id}:${reminder.dueUtc}`;
    this.outbox.enqueue({ kind: "push", dedupeKey: `${key}:push`, payload: reminderNotification(reminder) }, now);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `${key}:chat`, payload: reminderMessage(reminder, late) }, now);
  }

  private enqueueDigest(missed: Reminder[], now: Date): void {
    const digest = createHash("sha256")
      .update(missed.map((reminder) => `${reminder.id}:${reminder.dueUtc}`).join("\n"))
      .digest("hex")
      .slice(0, 16);
    const key = `missed:${digest}`;
    this.outbox.enqueue({ kind: "push", dedupeKey: `${key}:push`, payload: missedRemindersNotification(missed.length) }, now);
    this.outbox.enqueue({ kind: "chat_message", dedupeKey: `${key}:chat`, payload: missedRemindersMessage(missed) }, now);
  }
}
