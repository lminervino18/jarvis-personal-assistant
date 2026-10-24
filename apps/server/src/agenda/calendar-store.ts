import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";
import { occurrencesBetween } from "./recurrence.js";

export interface CalendarEvent {
  id: string;
  title: string;
  startUtc: string;
  endUtc: string | null;
  timezone: string;
  allDay: boolean;
  rrule: string | null;
  location: string | null;
  notes: string | null;
  status: "confirmed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface Occurrence {
  event: CalendarEvent;
  startUtc: string;
  endUtc: string | null;
}

export interface NewCalendarEvent {
  title: string;
  startUtc: string;
  endUtc?: string;
  timezone: string;
  allDay?: boolean;
  rrule?: string;
  location?: string;
  notes?: string;
  turnId?: string;
}

export interface CalendarChanges {
  title?: string;
  startUtc?: string;
  endUtc?: string;
  location?: string;
  notes?: string;
  status?: CalendarEvent["status"];
}

interface EventRow {
  id: string;
  title: string;
  start_utc: string;
  end_utc: string | null;
  timezone: string;
  all_day: number;
  rrule: string | null;
  location: string | null;
  notes: string | null;
  status: CalendarEvent["status"];
  created_at: string;
  updated_at: string;
}

function toEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id,
    title: row.title,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    timezone: row.timezone,
    allDay: row.all_day === 1,
    rrule: row.rrule,
    location: row.location,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shift(utcIso: string, ms: number): string {
  return new Date(Date.parse(utcIso) + ms).toISOString();
}

function durationOf(event: CalendarEvent): number {
  return event.endUtc ? Date.parse(event.endUtc) - Date.parse(event.startUtc) : 0;
}

function overlaps(startUtc: string, endUtc: string | null, fromUtc: string, toUtc: string): boolean {
  return startUtc <= toUtc && (startUtc >= fromUtc || (endUtc ?? startUtc) > fromUtc);
}

/** The internal agenda, source of truth until an external calendar is connected. */
export class CalendarStore {
  constructor(private readonly db: Db) {}

  get(id: string): CalendarEvent | undefined {
    const row = this.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  create(input: NewCalendarEvent, now = new Date()): CalendarEvent {
    const id = randomUUID();
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO calendar_events (id, title, start_utc, end_utc, timezone, all_day, rrule, location, notes, status, created_turn_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.startUtc,
        input.endUtc ?? null,
        input.timezone,
        input.allDay ? 1 : 0,
        input.rrule ?? null,
        input.location ?? null,
        input.notes ?? null,
        input.turnId ?? null,
        at,
        at,
      );
    return this.get(id) as CalendarEvent;
  }

  /** Applies changes; moving the start without a new end keeps the event's duration. */
  update(id: string, changes: CalendarChanges, now = new Date()): CalendarEvent | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const startUtc = changes.startUtc ?? existing.startUtc;
    const endUtc =
      changes.endUtc !== undefined ? changes.endUtc : existing.endUtc && shift(startUtc, durationOf(existing));
    this.db
      .prepare(
        `UPDATE calendar_events SET title = ?, start_utc = ?, end_utc = ?, location = ?, notes = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        changes.title ?? existing.title,
        startUtc,
        endUtc,
        changes.location ?? existing.location,
        changes.notes ?? existing.notes,
        changes.status ?? existing.status,
        now.toISOString(),
        id,
      );
    return this.get(id);
  }

  /** Confirmed events overlapping [fromUtc, toUtc], with recurring series expanded in their zone. */
  occurrences(fromUtc: string, toUtc: string, limit: number): { occurrences: Occurrence[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE status = 'confirmed' AND start_utc <= @to AND (rrule IS NOT NULL OR COALESCE(end_utc, start_utc) >= @from)
         ORDER BY start_utc`,
      )
      .all({ from: fromUtc, to: toUtc }) as EventRow[];
    const result: Occurrence[] = [];
    for (const event of rows.map(toEvent)) {
      const duration = durationOf(event);
      const starts = event.rrule
        ? occurrencesBetween({ startUtc: event.startUtc, timezone: event.timezone, rule: event.rrule }, shift(fromUtc, -duration), toUtc, limit + 1)
        : [event.startUtc];
      for (const startUtc of starts) {
        const endUtc = event.endUtc ? shift(startUtc, duration) : null;
        if (overlaps(startUtc, endUtc, fromUtc, toUtc)) result.push({ event, startUtc, endUtc });
      }
    }
    result.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    return { occurrences: result.slice(0, limit), hasMore: result.length > limit };
  }
}
