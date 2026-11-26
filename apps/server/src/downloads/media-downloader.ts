import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MediaFormat } from "@jarvis/contracts";

export type Site = "YouTube" | "X" | "Instagram";

/** What to download: a page on one of the three sites, or the first YouTube result for some words. */
export interface DownloadRequest {
  source: "link" | "search";
  target: string;
  site: Site;
  format: MediaFormat;
}

export type DownloadFailure = "blocked" | "login" | "unavailable" | "too_big" | "unsupported" | "unconvertible" | "no_moment" | "timeout" | "cancelled" | "failed";

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
};

/** yt-dlp's own extractors for each site; its generic one stays off, so no link can make the server fetch other addresses. */
const EXTRACTORS: Record<Site, string> = { YouTube: "youtube.*", X: "twitter.*", Instagram: "instagram.*" };

const MAX_TITLE = 120;

/** The link and its site when it is a YouTube, X or Instagram page; undefined for anything else. */
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
  if (/confirm you.?re not a bot/i.test(output)) return "blocked";
  if (/max-filesize|larger than max/i.test(output)) return "too_big";
  if (/unsupported url/i.test(output)) return "unsupported";
  if (/private|login required|log in|sign in|requires authentication|cookies/i.test(output)) return "login";
  if (/unavailable|not available|removed|does not exist|404|no video/i.test(output)) return "unavailable";
  return "failed";
}

export interface MediaDownloaderOptions {
  /** The yt-dlp executable. */
  bin: string;
  /** Where yt-dlp keeps what it learns about each site between runs. */
  cacheDir: string;
  maxBytes: number;
  timeoutMs: number;
  /** Proxy only for YouTube, which blocks downloads from data center addresses. */
  youtubeProxy?: string;
  /** Netscape cookies file for sites that ask to sign in; copied per run because yt-dlp rewrites it. */
  cookiesFile?: string;
  spawnFn?: typeof spawn;
}

/** Downloads one video, or only its audio, with yt-dlp; ffmpeg merges and converts the streams. */
export class MediaDownloader {
  constructor(private readonly options: MediaDownloaderOptions) {}

  args(job: DownloadRequest, dir: string): string[] {
    const { options } = this;
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
      ...formatArgs(job.format),
      "-o",
      join(dir, "video.%(ext)s"),
      "--newline",
      "--progress",
      "--progress-template",
      "download:[progress] %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
      "--print",
      "after_move:[done] %(.{filepath,title,ext,height})j",
      ...(job.site === "YouTube" && options.youtubeProxy ? ["--proxy", options.youtubeProxy] : []),
      ...(cookies ? ["--cookies", cookies] : []),
    ];
  }

  /** Runs the download into `dir`; reports progress from 0 to 1 and stops when `signal` aborts. */
  run(job: DownloadRequest, dir: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<DownloadedFile> {
    const spawnFn = this.options.spawnFn ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(this.options.bin, this.args(job, dir), { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
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
