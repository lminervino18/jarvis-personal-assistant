import { decodeEntities } from "../integrations/google/text.js";

const CAMERAS = ["central", "izq", "der"] as const;
/** Beelup serves every match from its video servers; a playlist pointing anywhere else is refused. */
const SEGMENT_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.revivitupartido\.com\//i;
const REQUEST_TIMEOUT_MS = 20_000;

/** A recorded match: its HLS playlist, how long it is and how Beelup names it (court and time). */
export interface BeelupMatch {
  playlist: string;
  seconds: number;
  title: string;
}

export class BeelupError extends Error {}

/** The match id of a Beelup player link («https://beelup.com/player.php?id=38073765»). */
export function beelupId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id");
    return parsed.hostname.replace(/^www\./, "") === "beelup.com" && id && /^\d{1,12}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Seconds of video in an HLS playlist, and whether every segment comes from Beelup's servers. */
export function readPlaylist(text: string): { seconds: number; segments: number; trusted: boolean } {
  const lines = text.split("\n").map((line) => line.trim());
  const seconds = lines.reduce((total, line) => total + (line.startsWith("#EXTINF:") ? Number.parseFloat(line.slice(8)) || 0 : 0), 0);
  const urls = lines.filter((line) => line && !line.startsWith("#"));
  return { seconds, segments: urls.length, trusted: urls.every((url) => SEGMENT_HOST.test(url)) };
}

/**
 * Reads a match recorded by Beelup's court cameras: the player page for its name and each
 * camera's playlist, keeping the camera with the most video.
 */
export class BeelupSource {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async text(url: string, referer: string): Promise<string> {
    const response = await this.fetchFn(url, { headers: { "user-agent": "Mozilla/5.0", referer }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new BeelupError(`beelup answered ${response.status}`);
    return response.text();
  }

  async match(id: string): Promise<BeelupMatch> {
    const page = `https://beelup.com/player.php?id=${id}`;
    const html = await this.text(page, "https://beelup.com/");
    const title = decodeEntities(html.match(/<title>([^<]{1,200})<\/title>/i)?.[1] ?? "").trim() || `Partido ${id}`;
    let best: BeelupMatch | undefined;
    for (const camera of CAMERAS) {
      const playlist = await this.text(`https://beelup.com/obtener.video.playlist.php?id=${id}&camara=${camera}&tipo=todo&formato=m3u8&desde=&duracion=`, page);
      const read = readPlaylist(playlist);
      if (!read.segments) continue;
      if (!read.trusted) throw new BeelupError("the playlist points outside Beelup");
      if (!best || read.seconds > best.seconds) best = { playlist, seconds: read.seconds, title };
    }
    if (!best) throw new BeelupError("no video in any camera");
    return best;
  }
}
