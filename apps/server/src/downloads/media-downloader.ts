import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MediaFormat } from "@jarvis/contracts";

/** Sites yt-dlp downloads from. */
export type VideoSite = "YouTube" | "X" | "Instagram";
/** Every site a link can come from; Beelup matches are read from its own playlists, not by yt-dlp. */
export type Site = VideoSite | "Beelup";

/** What to download: a page on one of the three sites, or the first YouTube result for some words. */
export interface DownloadRequest {
  source: "link" | "search";
  target: string;
  site: VideoSite;
  format: MediaFormat;
}

export type DownloadFailure =
  | "blocked"
  | "offline"
  | "outdated"
  | "login"
  | "unavailable"
  | "too_big"
  | "unsupported"
  | "unconvertible"
  | "no_moment"
  | "timeout"
  | "cancelled"
  | "failed";

/** A failed download, with a reason the owner can act on. Never carries cookies, proxies or raw tool output. */
export class DownloadError extends Error {
  constructor(readonly reason: DownloadFailure) {
    super(reason);
  }
}

export interface DownloadedFile {
  path: string;
  title: string;
  ext: string;
  height?: number;
}

const HOSTS: Record<string, Site> = {
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube",
  "music.youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "x.com": "X",
  "mobile.x.com": "X",
  "twitter.com": "X",
  "mobile.twitter.com": "X",
  "instagram.com": "Instagram",
  "beelup.com": "Beelup",
};

/** yt-dlp's own extractors for each site; its generic one stays off, so no link can make the server fetch other addresses. */
const EXTRACTORS: Record<VideoSite, string> = { YouTube: "youtube.*", X: "twitter.*", Instagram: "instagram.*" };

const MAX_TITLE = 120;

/** The link and its site when it is a YouTube, X or Instagram page or a Beelup match; undefined for anything else. */
export function siteOf(input: string): { url: string; site: Site } | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.port) return undefined;
  const site = HOSTS[url.hostname.toLowerCase().replace(/^www\./, "")];
  if (!site) return undefined;
  if (site === "Beelup") {
    const id = url.pathname === "/player.php" ? url.searchParams.get("id") : null;
    return id && /^\d{1,12}$/.test(id) ? { url: `https://beelup.com/player.php?id=${id}`, site } : undefined;
  }
  url.protocol = "https:";
  return { url: url.toString(), site };
}

/** yt-dlp's format choice for each output: H.264 first for the iPhone, only the audio for MP3 and M4A. */
function formatArgs(format: MediaFormat): string[] {
  const video = ["--merge-output-format", "mp4", "--remux-video", "mp4"];
  if (format === "mp3") return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
  if (format === "m4a") return ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"];
  if (format === "iphone") return ["-f", "bv*+ba/b", "-S", "vcodec:h264,res,acodec:m4a", ...video];
  return ["-f", "bv*+ba/b", ...video];
}

/** Why yt-dlp failed, read from what it printed. */
export function failureOf(output: string): DownloadFailure {
  if (/confirm you.?re not a bot|rate.?limit|too many requests|429/i.test(output)) return "blocked";
  if (/max-filesize|larger than max/i.test(output)) return "too_big";
  if (/unsupported url/i.test(output)) return "unsupported";
  if (/unable to extract|nsig extraction|signature (extraction|function)|please report this issue|only images are available/i.test(output)) return "outdated";
  if (/private|login required|log in|sign in|requires authentication|cookies/i.test(output)) return "login";
  if (/unavailable|not available|removed|does not exist|404|no video/i.test(output)) return "unavailable";
  if (/timed out|unable to connect|connection (refused|reset|aborted)|network is unreachable|tunnel connection failed|socks|proxy|name resolution|name or service not known/i.test(output)) return "offline";
  return "failed";
}

/** Failures another route or a newer yt-dlp may get past; the rest are final. */
const RECOVERABLE: ReadonlySet<DownloadFailure> = new Set(["blocked", "offline", "outdated", "login", "failed"]);
const TUNNEL_FAILURES: ReadonlySet<DownloadFailure> = new Set(["blocked", "offline"]);
const MAX_HEALS = 2;

export interface MediaDownloaderOptions {
  /** The yt-dlp executable. */
  bin: string;
  /** Where yt-dlp keeps what it learns about each site between runs. */
  cacheDir: string;
  maxBytes: number;
  timeoutMs: number;
  /** The WARP tunnel: always first for YouTube, which blocks data center addresses; the second try for X and Instagram. */
  youtubeProxy?: string;
  /** Asks the tunnel to reconnect or to take a new identity; resolves true once it carries traffic again. */
  heal?(how: "restart" | "renew"): Promise<boolean>;
  /** A newer yt-dlp than `bin`, when the bundled one no longer understands a site. */
  freshBin?(): Promise<string | undefined>;
  /** Netscape cookies file for sites that ask to sign in; copied per run because yt-dlp rewrites it. */
  cookiesFile?: string;
  spawnFn?: typeof spawn;
}

/** Downloads one video, or only its audio, with yt-dlp; ffmpeg merges and converts the streams. */
export class MediaDownloader {
  constructor(private readonly options: MediaDownloaderOptions) {}

  /** Where each try goes out: YouTube through the tunnel and then direct; X and Instagram direct and then through the tunnel. */
  routes(site: VideoSite): (string | undefined)[] {
    const proxy = this.options.youtubeProxy;
    if (!proxy) return [undefined];
    return site === "YouTube" ? [proxy, undefined] : [undefined, proxy];
  }

  args(job: DownloadRequest, dir: string, route: { proxy: string | undefined } = { proxy: job.site === "YouTube" ? this.options.youtubeProxy : undefined }): string[] {
    const { options } = this;
    const { proxy } = route;
    const cookies = options.cookiesFile && existsSync(options.cookiesFile) ? join(dir, "cookies.txt") : undefined;
    if (cookies && options.cookiesFile) copyFileSync(options.cookiesFile, cookies);
    return [
      job.source === "search" ? `ytsearch1:${job.target.replace(/\s+/g, " ")}` : job.target,
      "--use-extractors",
      EXTRACTORS[job.site],
      "--no-playlist",
      "--no-warnings",
      "--color",
      "never",
      "--js-runtimes",
      "node",
      "--cache-dir",
      options.cacheDir,
      "--max-filesize",
      String(options.maxBytes),
      "--socket-timeout",
      "15",
      "--extractor-retries",
      "1",
      ...formatArgs(job.format),
      "-o",
      join(dir, "video.%(ext)s"),
      "--newline",
      "--progress",
      "--progress-template",
      "download:[progress] %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
      "--print",
      "after_move:[done] %(.{filepath,title,ext,height})j",
      ...(proxy ? ["--proxy", proxy] : []),
      ...(cookies ? ["--cookies", cookies] : []),
    ];
  }

  /**
   * Runs the download into `dir`, trying every route before giving up: a blocked or dead tunnel is
   * healed once or twice, and a yt-dlp that no longer understands the site is swapped for a newer one.
   * Reports progress from 0 to 1 and stops when `signal` aborts.
   */
  async run(job: DownloadRequest, dir: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<DownloadedFile> {
    let bin = this.options.bin;
    let updated = false;
    let last: DownloadFailure = "failed";
    for (const proxy of this.routes(job.site)) {
      let heals = 0;
      for (;;) {
        try {
          return await this.attempt(bin, job, dir, proxy, onProgress, signal);
        } catch (error) {
          const reason = error instanceof DownloadError ? error.reason : "failed";
          if (!RECOVERABLE.has(reason)) throw error;
          last = reason === "outdated" ? "failed" : reason;
          if (reason === "outdated" && !updated) {
            updated = true;
            const fresh = await this.options.freshBin?.();
            if (fresh) {
              bin = fresh;
              continue;
            }
          }
          if (proxy && TUNNEL_FAILURES.has(reason) && heals < MAX_HEALS && this.options.heal) {
            heals++;
            if (await this.options.heal(reason === "blocked" ? "renew" : "restart")) continue;
          }
          break;
        }
      }
    }
    throw new DownloadError(last);
  }

  private attempt(bin: string, job: DownloadRequest, dir: string, proxy: string | undefined, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<DownloadedFile> {
    if (signal.aborted) return Promise.reject(new DownloadError("cancelled"));
    const spawnFn = this.options.spawnFn ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(bin, this.args(job, dir, { proxy }), { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let done: DownloadedFile | undefined;
      let ended: DownloadFailure | undefined;
      const stop = (reason: DownloadFailure) => {
        ended = reason;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop("timeout"), this.options.timeoutMs);
      const onAbort = () => stop("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });

      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const progress = line.match(/^\[progress\] (\d+) (\d+)/);
          if (progress) onProgress(Math.min(1, Number(progress[1]) / Math.max(1, Number(progress[2]))));
          else if (line.startsWith("[done] ")) {
            const info = JSON.parse(line.slice(7)) as { filepath: string; title?: string; ext: string; height?: number };
            done = { path: info.filepath, title: (info.title ?? "video").slice(0, MAX_TITLE), ext: info.ext, ...(info.height ? { height: info.height } : {}) };
          } else output += `${line}\n`;
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-8000);
      });
      child.on("error", () => stop("failed"));
      child.on("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (ended) return reject(new DownloadError(ended));
        if (done && existsSync(done.path)) return resolve(done);
        reject(new DownloadError(failureOf(output)));
      });
    });
  }
}
