import type { Card } from "@jarvis/contracts";
import { DateTime } from "luxon";
import { CalendarStore, type CalendarEvent } from "../agenda/calendar-store.js";
import { formatLocal } from "../agenda/format.js";
import { checkRule } from "../agenda/recurrence.js";
import { toUtcIso, toZonedIso } from "../util/time.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "calendar" };
const LIST_LIMIT = 100;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const COVERAGE_NOTE =
  "Agenda interna de J.A.R.V.IS; no hay calendarios externos conectados. Las series recurrentes se expanden en su zona horaria.";

function present(event: CalendarEvent, startUtc = event.startUtc, endUtc = event.endUtc) {
  return {
    eventId: event.id,
    title: event.title,
    start: toZonedIso(startUtc, event.timezone),
    end: endUtc ? toZonedIso(endUtc, event.timezone) : null,
    timezone: event.timezone,
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    recurrence: event.rrule,
    status: event.status,
  };
}

function eventCard(event: CalendarEvent): Card {
  return {
    kind: "event",
    eventId: event.id,
    title: event.title,
    start: toZonedIso(event.startUtc, event.timezone),
    ...(event.endUtc ? { end: toZonedIso(event.endUtc, event.timezone) } : {}),
    timezone: event.timezone,
    ...(event.location ? { location: event.location } : {}),
  };
}

function storedTime(iso: string, allDay: boolean, timezone: string, isEnd: boolean): string {
  if (!allDay) return toUtcIso(iso);
  const date = DateTime.fromISO(iso, { setZone: true });
  const day = DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: timezone });
  return (isEnd ? day.plus({ days: 1 }) : day).toUTC().toISO() as string;
}

function details(entries: [string, string | undefined][]) {
  return entries.filter((entry): entry is [string, string] => Boolean(entry[1])).map(([label, value]) => ({ label, value }));
}

export const calendarList = defineTool({
  name: "calendar_list",
  description:
    "Lista los eventos de la agenda interna que se superponen con un rango de fechas, con las series recurrentes ya expandidas. Usalo siempre para preguntas sobre la agenda.",
  async execute(ctx, input) {
    const fromUtc = toUtcIso(input.from);
    const toUtc = toUtcIso(input.to);
    if (toUtc <= fromUtc) return fail("invalid_input", "El rango debe terminar después de empezar.");
    if (Date.parse(toUtc) - Date.parse(fromUtc) > MAX_RANGE_MS) return fail("invalid_input", "El rango no puede superar un año.");
    const { occurrences, hasMore } = new CalendarStore(ctx.services.db).occurrences(fromUtc, toUtc, LIST_LIMIT);
    return ok(
      SOURCE,
      occurrences.map((o) => present(o.event, o.startUtc, o.endUtc)),
      { page: { hasMore }, coverage: { from: input.from, to: input.to, note: COVERAGE_NOTE } },
    );
  },
});

export const calendarCreate = defineTool({
  name: "calendar_create",
  description:
    "Crea un evento en la agenda interna. Usá fechas con zona horaria. 'recurrence' acepta una RRULE simple (FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY sin ordinales).",
  describe(ctx, input) {
    const timezone = ctx.services.timezone;
    return {
      title: "Crear evento",
      summary: input.title,
      details: details([
        ["Cuándo", formatLocal(toUtcIso(input.start), timezone)],
        ["Hasta", input.end && formatLocal(toUtcIso(input.end), timezone)],
        ["Lugar", input.location],
        ["Repetición", input.recurrence],
      ]),
    };
  },
  async execute(ctx, input) {
    const timezone = ctx.services.timezone;
    const allDay = input.allDay ?? false;
    const checked = input.recurrence ? checkRule(input.recurrence, timezone) : undefined;
    if (checked && "error" in checked) return fail("invalid_input", checked.error);
    const startUtc = storedTime(input.start, allDay, timezone, false);
    const end = input.end ?? (allDay ? input.start : undefined);
    const endUtc = end ? storedTime(end, allDay, timezone, true) : undefined;
    if (endUtc && endUtc <= startUtc) return fail("invalid_input", "El fin debe ser posterior al inicio.");
    const event = new CalendarStore(ctx.services.db).create(
      {
        title: input.title,
        startUtc,
        endUtc,
        timezone,
        allDay,
        rrule: checked?.rule,
        location: input.location,
        notes: input.notes,
        turnId: ctx.turnId,
      },
      ctx.now(),
    );
    ctx.emitCard(eventCard(event));
    return ok(SOURCE, [present(event)], { note: "Evento guardado en la agenda interna." });
  },
});

export const calendarUpdate = defineTool({
  name: "calendar_update",
  description:
    "Modifica o cancela (status 'cancelled') un evento de la agenda interna. Si cambiás solo el inicio, se conserva la duración. En una serie recurrente el cambio aplica a toda la serie.",
  describe(ctx, input) {
    const timezone = ctx.services.timezone;
    const event = new CalendarStore(ctx.services.db).get(input.eventId);
    return {
      title: input.status === "cancelled" ? "Cancelar evento" : "Modificar evento",
      summary: event?.title ?? "Evento inexistente",
      details: details([
        ["Título", input.title],
        ["Inicio", input.start && formatLocal(toUtcIso(input.start), timezone)],
        ["Fin", input.end && formatLocal(toUtcIso(input.end), timezone)],
        ["Lugar", input.location],
        ["Notas", input.notes],
      ]),
    };
  },
  async execute(ctx, input) {
    const store = new CalendarStore(ctx.services.db);
    const existing = store.get(input.eventId);
    if (!existing) return fail("not_found", "No existe un evento con ese id.");
    const startUtc = input.start ? storedTime(input.start, existing.allDay, existing.timezone, false) : undefined;
    const endUtc = input.end ? storedTime(input.end, existing.allDay, existing.timezone, true) : undefined;
    if (endUtc && endUtc <= (startUtc ?? existing.startUtc)) return fail("invalid_input", "El fin debe ser posterior al inicio.");
    const event = store.update(
      input.eventId,
      { title: input.title, startUtc, endUtc, location: input.location, notes: input.notes, status: input.status },
      ctx.now(),
    ) as CalendarEvent;
    if (event.status === "cancelled") return ok(SOURCE, [present(event)], { note: "Evento cancelado." });
    ctx.emitCard(eventCard(event));
    return ok(SOURCE, [present(event)], { note: "Evento actualizado." });
  },
});

export const calendarTools = [calendarList, calendarCreate, calendarUpdate];
