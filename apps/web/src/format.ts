export const OWNER_TIME_ZONE = "America/Argentina/Buenos_Aires";

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("es-AR", { timeZone, hour12: false, ...options });
  } catch {
    return new Intl.DateTimeFormat("es-AR", { timeZone: OWNER_TIME_ZONE, hour12: false, ...options });
  }
}

export function formatTime(iso: string, timeZone = OWNER_TIME_ZONE): string {
  return formatter(timeZone, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function formatDateTime(iso: string, timeZone = OWNER_TIME_ZONE): string {
  return formatter(timeZone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function formatDay(iso: string, now: Date, timeZone = OWNER_TIME_ZONE): string {
  const key = (date: Date) => formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const date = new Date(iso);
  if (key(date) === key(now)) return "Hoy";
  if (key(date) === key(new Date(now.getTime() - 86_400_000))) return "Ayer";
  return formatter(timeZone, { weekday: "short", day: "numeric", month: "short" }).format(date);
}

/** Only web links and same-site paths may become `href`s; anything else (javascript:, data:) is dropped. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
