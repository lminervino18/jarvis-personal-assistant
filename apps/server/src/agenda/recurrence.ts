import { DateTime } from "luxon";

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const FREQUENCIES = { DAILY: "days", WEEKLY: "weeks", MONTHLY: "months", YEARLY: "years" } as const;
const MAX_COUNT = 1000;
const MAX_INTERVAL = 365;
const HORIZON_YEARS = 10;
const UTC_BASIC = "yyyyMMdd'T'HHmmss";

type Frequency = keyof typeof FREQUENCIES;

interface Rule {
  freq: Frequency;
  interval: number;
  count?: number;
  until?: DateTime;
  byDay?: number[];
}

/** A recurring series: the first occurrence in UTC, the IANA zone it repeats in, and its RRULE. */
export interface Series {
  startUtc: string;
  timezone: string;
  rule: string;
}

export class RecurrenceError extends Error {}

function parseUntil(value: string, timezone: string): DateTime {
  const parsed = value.endsWith("Z")
    ? DateTime.fromFormat(value.slice(0, -1), UTC_BASIC, { zone: "utc" })
    : value.includes("T")
      ? DateTime.fromFormat(value, UTC_BASIC, { zone: timezone })
      : DateTime.fromFormat(value, "yyyyMMdd", { zone: timezone }).endOf("day");
  if (!parsed.isValid) throw new RecurrenceError(`UNTIL inválido: ${value}`);
  return parsed;
}

function parseInteger(value: string, key: string, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < 1 || parsed > max) throw new RecurrenceError(`${key} inválido: ${value}`);
  return parsed;
}

function parseByDay(value: string): number[] {
  const days = value.split(",").map((code) => WEEKDAYS.indexOf(code) + 1);
  if (days.includes(0)) throw new RecurrenceError(`BYDAY solo admite días sin ordinal (MO..SU): ${value}`);
  return [...new Set(days)].sort((a, b) => a - b);
}

function parseRule(text: string, timezone: string): Rule {
  const parts = new Map<string, string>();
  for (const part of text.trim().replace(/^RRULE:/i, "").toUpperCase().split(";").filter(Boolean)) {
    const [key, value, ...rest] = part.split("=");
    if (!key || !value || rest.length > 0) throw new RecurrenceError(`Parte inválida en la regla: ${part}`);
    parts.set(key, value);
  }
  const freq = parts.get("FREQ");
  if (!freq || !(freq in FREQUENCIES)) throw new RecurrenceError("FREQ debe ser DAILY, WEEKLY, MONTHLY o YEARLY.");
  const rule: Rule = { freq: freq as Frequency, interval: 1 };
  for (const [key, value] of parts) {
    if (key === "FREQ") continue;
    else if (key === "INTERVAL") rule.interval = parseInteger(value, key, MAX_INTERVAL);
    else if (key === "COUNT") rule.count = parseInteger(value, key, MAX_COUNT);
    else if (key === "UNTIL") rule.until = parseUntil(value, timezone);
    else if (key === "BYDAY") rule.byDay = parseByDay(value);
    else if (key === "WKST" && value === "MO") continue;
    else throw new RecurrenceError(`Parte de la regla no soportada: ${key}`);
  }
  if (rule.count && rule.until) throw new RecurrenceError("COUNT y UNTIL no pueden usarse juntos.");
  if (rule.byDay && rule.freq !== "DAILY" && rule.freq !== "WEEKLY") {
    throw new RecurrenceError("BYDAY solo se admite con FREQ=DAILY o FREQ=WEEKLY.");
  }
  return rule;
}

function formatRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.map((day) => WEEKDAYS[day - 1]).join(",")}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.toUTC().toFormat(UTC_BASIC)}Z`);
  return parts.join(";");
}

function onDayOf(monthStart: DateTime, start: DateTime): DateTime[] {
  if (start.day > (monthStart.daysInMonth ?? 0)) return [];
  return [monthStart.set({ day: start.day, hour: start.hour, minute: start.minute, second: start.second, millisecond: start.millisecond })];
}

function candidatesFor(start: DateTime, rule: Rule, period: number): DateTime[] {
  const step = period * rule.interval;
  switch (rule.freq) {
    case "DAILY": {
      const day = start.plus({ days: step });
      return !rule.byDay || rule.byDay.includes(day.weekday) ? [day] : [];
    }
    case "WEEKLY": {
      if (!rule.byDay) return [start.plus({ weeks: step })];
      const weekStart = start.startOf("week").plus({ weeks: step });
      const time = { hour: start.hour, minute: start.minute, second: start.second, millisecond: start.millisecond };
      return rule.byDay.map((weekday) => weekStart.plus({ days: weekday - 1 }).set(time));
    }
    case "MONTHLY":
      return onDayOf(start.startOf("month").plus({ months: step }), start);
    case "YEARLY":
      return onDayOf(start.startOf("year").plus({ years: step }).set({ month: start.month }), start);
  }
}

function* iterate(start: DateTime, rule: Rule, end: DateTime): Generator<DateTime> {
  let emitted = 0;
  for (let period = 0; ; period++) {
    const candidates = candidatesFor(start, rule, period);
    for (const candidate of candidates) {
      if (candidate < start) continue;
      if (candidate > end || (rule.until && candidate > rule.until)) return;
      if (rule.count !== undefined && emitted >= rule.count) return;
      emitted++;
      yield candidate;
    }
    if (candidates.length === 0 && start.plus({ [FREQUENCIES[rule.freq]]: period * rule.interval }) > end) return;
  }
}

function startOf(series: Series): DateTime {
  return DateTime.fromISO(series.startUtc, { zone: "utc" }).setZone(series.timezone);
}

function utcIso(date: DateTime): string {
  return date.toUTC().toISO() as string;
}

function horizon(from: DateTime, rule: Rule): DateTime {
  return from.plus({ years: HORIZON_YEARS }).plus({ [FREQUENCIES[rule.freq]]: rule.interval * 2 });
}

/** Validates an RRULE (supported subset) and returns it in canonical form. Throws RecurrenceError. */
export function normalizeRule(text: string, timezone: string): string {
  return formatRule(parseRule(text, timezone));
}

/** Canonical form of a rule, or the reason it is not supported. */
export function checkRule(text: string, timezone: string): { rule: string } | { error: string } {
  try {
    return { rule: normalizeRule(text, timezone) };
  } catch (error) {
    if (error instanceof RecurrenceError) return { error: `Repetición no soportada: ${error.message}` };
    throw error;
  }
}

/**
 * Canonical rule whose meaning does not depend on the series start: COUNT becomes the
 * UNTIL of its last occurrence, so the start can advance as occurrences fire.
 */
export function anchoredRule(series: Series): string {
  const rule = parseRule(series.rule, series.timezone);
  if (!rule.count) return formatRule(rule);
  const start = startOf(series);
  const end = start.plus({ [FREQUENCIES[rule.freq]]: rule.interval * (rule.count * 7 + 1) });
  let last = start;
  for (const occurrence of iterate(start, rule, end)) last = occurrence;
  return formatRule({ ...rule, count: undefined, until: last.toUTC() });
}

/** Occurrence starts (UTC ISO) within [fromUtc, toUtc], at most `limit` of them. */
export function occurrencesBetween(series: Series, fromUtc: string, toUtc: string, limit: number): string[] {
  const rule = parseRule(series.rule, series.timezone);
  const from = DateTime.fromISO(fromUtc, { zone: "utc" });
  const result: string[] = [];
  for (const occurrence of iterate(startOf(series), rule, DateTime.fromISO(toUtc, { zone: "utc" }))) {
    if (occurrence < from) continue;
    result.push(utcIso(occurrence));
    if (result.length >= limit) break;
  }
  return result;
}

/** First occurrence (UTC ISO) at or after `atUtc`, or undefined when the series has ended. */
export function nextOccurrence(series: Series, atUtc: string): string | undefined {
  const rule = parseRule(series.rule, series.timezone);
  const at = DateTime.fromISO(atUtc, { zone: "utc" });
  for (const occurrence of iterate(startOf(series), rule, horizon(at, rule))) {
    if (occurrence >= at) return utcIso(occurrence);
  }
  return undefined;
}
