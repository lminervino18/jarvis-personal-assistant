import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { join } from "node:path";
import type { MediaFormat } from "@jarvis/contracts";
import type { Exec } from "../videos/video-qa.js";
import { DownloadError } from "./media-downloader.js";

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
