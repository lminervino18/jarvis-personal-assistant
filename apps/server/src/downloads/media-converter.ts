import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { MediaFormat } from "@jarvis/contracts";
import type { Exec } from "../videos/video-qa.js";
import { DownloadError } from "./media-downloader.js";
import type { Moment } from "./moment-finder.js";

export type ConvertFormat = Exclude<MediaFormat, "max">;

/** What a file holds, as far as a conversion cares. */
export interface Probe {
  /** Seconds; 0 when the container does not say. */
  duration: number;
  video?: { codec: string; width: number; height: number };
  audio?: { codec: string };
}

interface ProbeJson {
  format?: { duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[];
}

const EXTENSIONS: Record<ConvertFormat, string> = { mp3: "mp3", m4a: "m4a", iphone: "mp4" };
/** The short side of a re-encoded video: 1080p keeps a 4K source watchable without hours of work on the server. */
const MAX_SHORT_SIDE = 1080;
const BACKGROUND_PRIORITY = 10;
/** Below this, a compressed video is no longer worth watching: better a link. */
const MIN_VIDEO_KBPS = 100;

function lowerPriority(pid: number): void {
  try {
    setPriority(pid, BACKGROUND_PRIORITY);
  } catch {
    return;
  }
}

/** Reads ffprobe's JSON; cover art inside audio files does not count as video. */
export function parseProbe(json: string): Probe {
  const data = JSON.parse(json) as ProbeJson;
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    duration: Number(data.format?.duration) || 0,
    ...(video?.codec_name ? { video: { codec: video.codec_name, width: video.width ?? 0, height: video.height ?? 0 } } : {}),
    ...(audio?.codec_name ? { audio: { codec: audio.codec_name } } : {}),
  };
}

function iphoneVideo(video: NonNullable<Probe["video"]>): string[] {
  if (video.codec === "h264") return ["-c:v", "copy"];
  if (video.codec === "hevc") return ["-c:v", "copy", "-tag:v", "hvc1"];
  const scale = `scale=w='if(gte(iw,ih),-2,min(iw,${MAX_SHORT_SIDE}))':h='if(gte(iw,ih),min(ih,${MAX_SHORT_SIDE}),-2)'`;
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", scale];
}

/**
 * The ffmpeg arguments that turn a file into `format`, copying every stream that already fits so
 * nothing is lost; undefined when the file has nothing to convert (no audio for MP3, no video for the iPhone).
 */
export function conversionArgs(probe: Probe, format: ConvertFormat, input: string, output: string): string[] | undefined {
  const head = ["-hide_banner", "-nostdin", "-y", "-i", input];
  const tail = ["-progress", "pipe:1", "-nostats", output];
  if (format === "mp3") {
    if (!probe.audio) return undefined;
    return [...head, "-map", "0:a:0", "-vn", ...(probe.audio.codec === "mp3" ? ["-c:a", "copy"] : ["-c:a", "libmp3lame", "-q:a", "0"]), ...tail];
  }
  if (format === "m4a") {
    if (!probe.audio) return undefined;
    return [...head, "-map", "0:a:0", "-vn", ...(probe.audio.codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "256k"]), "-movflags", "+faststart", ...tail];
  }
  if (!probe.video) return undefined;
  const audio = !probe.audio ? [] : probe.audio.codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
  return [...head, "-map", "0:v:0", "-map", "0:a:0?", ...iphoneVideo(probe.video), ...audio, "-movflags", "+faststart", ...tail];
}

export interface CutOptions {
  format: "iphone" | "mp3";
  /** Cropped to 9:16 from the middle, for stories or reels. */
  vertical: boolean;
}

/**
 * The ffmpeg arguments that keep only `moments`, joined in order. Each part is read with its own
 * fast seek, so a short cut of a two-hour match does not decode the whole match.
 */
export function cutArgs(probe: Probe, moments: Moment[], options: CutOptions, input: string, output: string): string[] | undefined {
  const video = options.format === "iphone" ? probe.video : undefined;
  if (options.format === "iphone" && !video) return undefined;
  if (options.format === "mp3" && !probe.audio) return undefined;
  const audio = Boolean(probe.audio);
  const inputs = moments.flatMap((moment) => ["-ss", moment.start.toFixed(3), "-t", (moment.end - moment.start).toFixed(3), "-i", input]);
  const streams = moments.map((_moment, index) => `${video ? `[${index}:v:0]` : ""}${audio ? `[${index}:a:0]` : ""}`).join("");
  const joined = `${streams}concat=n=${moments.length}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}${video ? "[v]" : ""}${audio ? "[a]" : ""}`;
  const head = ["-hide_banner", "-nostdin", "-y", ...inputs];
  const tail = ["-progress", "pipe:1", "-nostats", output];
  if (!video) return [...head, "-filter_complex", joined, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "0", ...tail];
  const portrait = options.vertical || video.height > video.width;
  const crop = options.vertical ? "crop=w='trunc(min(iw,ih*9/16)/2)*2':h=ih," : "";
  const scale = portrait ? `scale=w='trunc(min(iw,${MAX_SHORT_SIDE})/2)*2':h=-2` : `scale=w=-2:h='trunc(min(ih,${MAX_SHORT_SIDE})/2)*2'`;
  return [
    ...head,
    "-filter_complex",
    `${joined};[v]${crop}${scale},format=yuv420p[out]`,
    "-map",
    "[out]",
    ...(audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    ...tail,
  ];
}

/** How tall the converted video comes out, for the owner's notice. */
function outputHeight(probe: Probe, format: ConvertFormat): number | undefined {
  const video = probe.video;
  if (format !== "iphone" || !video) return undefined;
  if (video.codec === "h264" || video.codec === "hevc") return video.height || undefined;
  return video.width >= video.height ? Math.min(video.height, MAX_SHORT_SIDE) : Math.round((video.height * Math.min(video.width, MAX_SHORT_SIDE)) / Math.max(1, video.width));
}

export interface MediaConverterOptions {
  ffmpeg?: string;
  ffprobe?: string;
  timeoutMs: number;
  exec: Exec;
  spawnFn?: typeof spawn;
}

/** Converts a file with ffmpeg at low priority, so a long conversion never slows the chat. */
export class MediaConverter {
  constructor(private readonly options: MediaConverterOptions) {}

  async probe(input: string): Promise<Probe> {
    const { stdout } = await this.options.exec(this.options.ffprobe ?? "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", input]);
    return parseProbe(stdout);
  }

  /** Converts `input` into `dir`; reports progress from 0 to 1 and stops when `signal` aborts. */
  async run(input: string, format: ConvertFormat, dir: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ path: string; ext: string; height?: number }> {
    let probe: Probe;
    try {
      probe = await this.probe(input);
    } catch {
      throw new DownloadError("unconvertible");
    }
    const ext = EXTENSIONS[format];
    const output = join(dir, `converted.${ext}`);
    const args = conversionArgs(probe, format, input, output);
    if (!args) throw new DownloadError("unconvertible");
    await this.ffmpeg(args, probe.duration, onProgress, signal);
    const height = outputHeight(probe, format);
    return { path: output, ext, ...(height ? { height } : {}) };
  }

  /** Keeps only `moments` of a file, joined in order, as an iPhone video or as MP3. */
  async cut(input: string, moments: Moment[], options: CutOptions, dir: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ path: string; ext: string; seconds: number }> {
    let probe: Probe;
    try {
      probe = await this.probe(input);
    } catch {
      throw new DownloadError("unconvertible");
    }
    const ext = options.format === "mp3" ? "mp3" : "mp4";
    const output = join(dir, `cut.${ext}`);
    const args = cutArgs(probe, moments, options, input, output);
    if (!args) throw new DownloadError("unconvertible");
    const seconds = moments.reduce((total, moment) => total + moment.end - moment.start, 0);
    await this.ffmpeg(args, seconds, onProgress, signal);
    return { path: output, ext, seconds };
  }

  /** Saves an HLS playlist (a Beelup match) as one MP4 without re-encoding: every frame as it was recorded. */
  async remuxHls(playlist: string, output: string, seconds: number, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    await this.ffmpeg(
      ["-hide_banner", "-nostdin", "-y", "-protocol_whitelist", "file,https,tls,tcp,crypto", "-i", playlist, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output],
      seconds,
      onProgress,
      signal,
    );
  }

  /** Keeps `from` to `to` of a video without re-encoding; the cut lands on the nearest keyframe, within a second or two. */
  async trimCopy(input: string, from: number, to: number, output: string, signal: AbortSignal): Promise<void> {
    await this.ffmpeg(
      ["-hide_banner", "-nostdin", "-y", "-ss", from.toFixed(2), "-i", input, "-t", (to - from).toFixed(2), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", output],
      to - from,
      () => undefined,
      signal,
    );
  }

  /**
   * A copy of a video that weighs at most `targetBytes`, for channels with a size limit: H.264 at
   * the bitrate that fits, at the smallest resolution step that still looks fine. Undefined when the
   * video is too long to fit with a watchable quality.
   */
  async compress(input: string, targetBytes: number, dir: string, signal: AbortSignal): Promise<string | undefined> {
    const probe = await this.probe(input).catch(() => undefined);
    if (!probe?.video || probe.duration <= 0) return undefined;
    const output = join(dir, "compressed.mp4");
    const audioKbps = probe.audio ? 96 : 0;
    for (const share of [0.9, 0.7, 0.5]) {
      const videoKbps = Math.floor((targetBytes * 8 * share) / 1000 / probe.duration - audioKbps);
      if (videoKbps < MIN_VIDEO_KBPS) return undefined;
      const shortSide = videoKbps > 2500 ? 1080 : videoKbps > 1200 ? 720 : videoKbps > 600 ? 540 : 360;
      const portrait = probe.video.height > probe.video.width;
      const scale = portrait ? `scale=w='trunc(min(iw,${shortSide})/2)*2':h=-2` : `scale=w=-2:h='trunc(min(ih,${shortSide})/2)*2'`;
      await this.ffmpeg(
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-b:v",
          `${videoKbps}k`,
          "-maxrate",
          `${Math.floor(videoKbps * 1.3)}k`,
          "-bufsize",
          `${videoKbps * 2}k`,
          "-pix_fmt",
          "yuv420p",
          "-vf",
          scale,
          ...(probe.audio ? ["-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2"] : []),
          "-movflags",
          "+faststart",
          "-progress",
          "pipe:1",
          "-nostats",
          output,
        ],
        probe.duration,
        () => undefined,
        signal,
      );
      if (statSync(output).size <= targetBytes) return output;
    }
    return undefined;
  }

  private ffmpeg(args: string[], duration: number, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
    const spawnFn = this.options.spawnFn ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(this.options.ffmpeg ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
      if (child.pid) lowerPriority(child.pid);
      let ended: "timeout" | "cancelled" | undefined;
      const stop = (reason: "timeout" | "cancelled") => {
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
          const time = line.match(/^out_time_us=(\d+)/);
          if (time && duration > 0) onProgress(Math.min(1, Number(time[1]) / 1e6 / duration));
        }
      });
      child.on("error", () => reject(new DownloadError("unconvertible")));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (ended) return reject(new DownloadError(ended));
        if (code !== 0) return reject(new DownloadError("unconvertible"));
        onProgress(1);
        resolve();
      });
    });
  }
}
