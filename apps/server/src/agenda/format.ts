import { DateTime } from "luxon";

/** Human-readable local date and time in Spanish, for confirmation cards and chat messages. */
export function formatLocal(utcIso: string, timezone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone).setLocale("es-AR").toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm");
}

export function formatLocalTime(utcIso: string, timezone: string): string {
  return DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone).toFormat("HH:mm");
}
