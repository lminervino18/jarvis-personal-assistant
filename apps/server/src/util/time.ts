import { DateTime } from "luxon";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Converts an ISO timestamp with offset into canonical UTC ISO for storage. */
export function toUtcIso(isoWithOffset: string): string {
  const parsed = DateTime.fromISO(isoWithOffset, { setZone: true });
  if (!parsed.isValid) throw new Error(`invalid datetime: ${isoWithOffset}`);
  return parsed.toUTC().toISO({ suppressMilliseconds: false }) as string;
}

/** Renders a UTC timestamp in the owner's zone with its offset, for tool results. */
export function toZonedIso(utcIso: string, timezone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone).toISO({ suppressMilliseconds: true }) as string;
}

/**
 * The per-turn temporal header. It travels with each user message (not the system
 * prompt) so resumed sessions always interpret "mañana" against the real current date.
 */
export function temporalContext(now: Date, timezone: string): string {
  const local = DateTime.fromJSDate(now).setZone(timezone).setLocale("es-AR");
  return `${local.toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm")} (${timezone}, UTC${local.toFormat("ZZ")})`;
}
