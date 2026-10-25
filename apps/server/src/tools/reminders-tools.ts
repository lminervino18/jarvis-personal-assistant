import type { Card } from "@jarvis/contracts";
import { formatLocal } from "../agenda/format.js";
import { anchoredRule, checkRule, nextOccurrence } from "../agenda/recurrence.js";
import { ReminderStore, type Reminder } from "../agenda/reminders-store.js";
import { toUtcIso, toZonedIso } from "../util/time.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "reminders" };
const PAST_TOLERANCE_MS = 60_000;
const DEFAULT_LIMIT = 20;

function present(reminder: Reminder) {
  return {
    id: reminder.id,
    text: reminder.text,
    dueAt: toZonedIso(reminder.dueUtc, reminder.timezone),
    timezone: reminder.timezone,
    recurrence: reminder.rrule,
    sensitive: reminder.sensitive,
    status: reminder.status,
    lastFiredAt: reminder.lastFiredUtc ? toZonedIso(reminder.lastFiredUtc, reminder.timezone) : null,
  };
}

function reminderCard(reminder: Reminder): Card {
  return {
    kind: "reminder",
    reminderId: reminder.id,
    text: reminder.text,
    dueAt: toZonedIso(reminder.dueUtc, reminder.timezone),
    timezone: reminder.timezone,
    status: reminder.status,
  };
}

/** Resolves when a reminder is due: one-off dates must be in the future; series move to their next occurrence. */
function plan(dueUtc: string, rule: string | null, timezone: string, now: Date): { dueUtc: string; rrule: string | null } | { error: string } {
  const earliest = new Date(now.getTime() - PAST_TOLERANCE_MS).toISOString();
  if (!rule) return dueUtc < earliest ? { error: "Esa fecha ya pasó; pedí una fecha futura." } : { dueUtc, rrule: null };
  const checked = checkRule(rule, timezone);
  if ("error" in checked) return checked;
  const anchored = anchoredRule({ startUtc: dueUtc, timezone, rule: checked.rule });
  const next = nextOccurrence({ startUtc: dueUtc, timezone, rule: anchored }, dueUtc > earliest ? dueUtc : earliest);
  return next ? { dueUtc: next, rrule: anchored } : { error: "La repetición no tiene ocurrencias futuras." };
}

function whenDetails(dueAt: string | undefined, recurrence: string | null | undefined, timezone: string) {
  return [
    ...(dueAt ? [{ label: "Cuándo", value: formatLocal(toUtcIso(dueAt), timezone) }] : []),
    ...(recurrence !== undefined ? [{ label: "Repetición", value: recurrence ?? "sin repetición" }] : []),
  ];
}

export const remindersCreate = defineTool({
  name: "reminders_create",
  description:
    "Crea un recordatorio que suena aunque Claude no esté disponible. Usá fecha con zona horaria. 'recurrence' acepta una RRULE simple (FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY sin ordinales). Marcá 'sensitive' si el texto no debe verse en la notificación.",
  describe(ctx, input) {
    return {
      title: "Crear recordatorio",
      summary: input.text,
      details: [
        ...whenDetails(input.dueAt, input.recurrence, ctx.services.timezone),
        ...(input.sensitive ? [{ label: "Privado", value: "Sí" }] : []),
      ],
    };
  },
  async execute(ctx, input) {
    const timezone = ctx.services.timezone;
    const planned = plan(toUtcIso(input.dueAt), input.recurrence ?? null, timezone, ctx.now());
    if ("error" in planned) return fail("invalid_input", planned.error);
    const { reminder, duplicate } = new ReminderStore(ctx.services.db).create(
      {
        text: input.text,
        dueUtc: planned.dueUtc,
        timezone,
        rrule: planned.rrule ?? undefined,
        sensitive: input.sensitive,
        turnId: ctx.turnId,
      },
      ctx.now(),
    );
    ctx.emitCard(reminderCard(reminder));
    return ok(SOURCE, [present(reminder)], {
      note: duplicate ? "Ya existía un recordatorio igual para ese momento; no se duplicó." : "Recordatorio programado.",
    });
  },
});

export const remindersList = defineTool({
  name: "reminders_list",
  description:
    "Lista recordatorios por estado (por defecto los programados), opcionalmente en un rango de fechas. En los recurrentes, dueAt es la próxima vez que suenan.",
  async execute(ctx, input) {
    const status = input.status ?? "scheduled";
    const { reminders, hasMore } = new ReminderStore(ctx.services.db).list(
      { status, fromUtc: input.from ? toUtcIso(input.from) : undefined, toUtc: input.to ? toUtcIso(input.to) : undefined },
      input.limit ?? DEFAULT_LIMIT,
    );
    return ok(SOURCE, reminders.map(present), {
      page: { hasMore },
      coverage: { from: input.from, to: input.to, note: `Recordatorios en estado ${status}.` },
    });
  },
});

export const remindersUpdate = defineTool({
  name: "reminders_update",
  description:
    "Modifica el texto, la fecha o la repetición de un recordatorio (recurrence null la quita). Cambiar la fecha de uno que ya sonó lo vuelve a programar.",
  describe(ctx, input) {
    const reminder = new ReminderStore(ctx.services.db).get(input.reminderId);
    return {
      title: "Modificar recordatorio",
      summary: reminder?.text ?? "Recordatorio inexistente",
      details: [
        ...(input.text ? [{ label: "Nuevo texto", value: input.text }] : []),
        ...whenDetails(input.dueAt, input.recurrence, ctx.services.timezone),
      ],
    };
  },
  async execute(ctx, input) {
    const store = new ReminderStore(ctx.services.db);
    const existing = store.get(input.reminderId);
    if (!existing) return fail("not_found", "No existe un recordatorio con ese id.");
    if (existing.status === "cancelled") return fail("invalid_input", "Ese recordatorio está cancelado; creá uno nuevo.");
    const reschedule = input.dueAt !== undefined || input.recurrence !== undefined;
    let changes: Parameters<ReminderStore["update"]>[1] = { text: input.text };
    if (reschedule) {
      const dueUtc = input.dueAt ? toUtcIso(input.dueAt) : existing.dueUtc;
      const rule = input.recurrence !== undefined ? input.recurrence : existing.rrule;
      const planned = plan(dueUtc, rule, existing.timezone, ctx.now());
      if ("error" in planned) return fail("invalid_input", planned.error);
      changes = { ...changes, dueUtc: planned.dueUtc, rrule: planned.rrule, status: "scheduled" };
    }
    const reminder = store.update(input.reminderId, changes, ctx.now()) as Reminder;
    ctx.emitCard(reminderCard(reminder));
    return ok(SOURCE, [present(reminder)], { note: "Recordatorio actualizado." });
  },
});

export const remindersCancel = defineTool({
  name: "reminders_cancel",
  description: "Cancela un recordatorio programado.",
  describe(ctx, input) {
    const reminder = new ReminderStore(ctx.services.db).get(input.reminderId);
    return { title: "Cancelar recordatorio", summary: reminder?.text ?? "Recordatorio inexistente", details: [] };
  },
  async execute(ctx, input) {
    const store = new ReminderStore(ctx.services.db);
    const existing = store.get(input.reminderId);
    if (!existing) return fail("not_found", "No existe un recordatorio con ese id.");
    if (existing.status === "cancelled") return ok(SOURCE, [present(existing)], { note: "Ya estaba cancelado." });
    const cancelled = store.cancel(input.reminderId, ctx.now());
    if (!cancelled) return fail("invalid_input", "Ese recordatorio ya sonó y no se repite; no hay nada que cancelar.");
    ctx.emitCard(reminderCard(cancelled));
    return ok(SOURCE, [present(cancelled)], { note: "Recordatorio cancelado." });
  },
});

export const remindersTools = [remindersCreate, remindersList, remindersUpdate, remindersCancel];
