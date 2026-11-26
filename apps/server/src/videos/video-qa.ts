import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VideoTimeline } from "@jarvis/video/timeline";
import type { VideoQa } from "./video-store.js";

const run = promisify(execFile);
const TIMEOUT_MS = 5 * 60_000;

export type Exec = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultExec: Exec = async (command, args) => {
  const { stdout, stderr } = await run(command, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return { stdout, stderr };
};

/** Moves the index to the front so phones start playing before the whole file arrives. */
export async function fastStart(exec: Exec, input: string, output: string): Promise<void> {
  await exec("ffmpeg", ["-v", "error", "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output]);
}

/** A 720p copy for chats with tight limits. */
export async function lightVersion(exec: Exec, input: string, output: string, vertical: boolean): Promise<void> {
  const scale = vertical ? "scale=720:-2" : "scale=-2:720";
  await exec("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", output]);
}

export async function thumbnail(exec: Exec, input: string, output: string, atMs: number): Promise<void> {
  await exec("ffmpeg", ["-v", "error", "-y", "-ss", (atMs / 1000).toFixed(2), "-i", input, "-frames:v", "1", "-q:v", "3", output]);
}

interface Probe {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string }[];
  format?: { duration?: string };
}

/** Words of the script that the recognizer heard, as a share of all script words. */
export function wordRecall(script: string, heard: string): number {
  const clean = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3);
  const expected = clean(script);
  const got = new Set(clean(heard));
  if (expected.length === 0) return 1;
  return expected.filter((word) => got.has(word)).length / expected.length;
}

export interface QaInput {
  exec: Exec;
  file: string;
  timeline: VideoTimeline;
  /** Script and recognized text of each narrated segment, the intro first; absent without STT. */
  transcripts?: { script: string; heard: string }[];
}

/**
 * Checks the final file, not the preview: codecs and size, length against the timeline, black
 * frames, long silences, clipping, captions in order, and that the narration says the script.
 */
export async function checkVideo(input: QaInput): Promise<VideoQa> {
  const { exec, file, timeline } = input;
  const checks: VideoQa["checks"] = [];
  const probe = JSON.parse(
    (await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt", "-of", "json", file])).stdout,
  ) as Probe;
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const playable = video?.codec_name === "h264" && video.pix_fmt === "yuv420p" && audio?.codec_name === "aac" && video.width === timeline.width && video.height === timeline.height;
  checks.push({ name: "archivo", ok: playable, detail: `${video?.codec_name ?? "sin video"} ${video?.width ?? 0}x${video?.height ?? 0} ${video?.pix_fmt ?? ""}, audio ${audio?.codec_name ?? "ninguno"}` });

  const durationMs = Number(probe.format?.duration ?? 0) * 1000;
  checks.push({ name: "duración", ok: Math.abs(durationMs - timeline.durationMs) < 400, detail: `${(durationMs / 1000).toFixed(1)} s (esperado ${(timeline.durationMs / 1000).toFixed(1)} s)` });

  const black = (await exec("ffmpeg", ["-v", "info", "-i", file, "-vf", "blackdetect=d=0.1:pix_th=0.1", "-an", "-f", "null", "-"])).stderr;
  const blackCount = (black.match(/black_start/g) ?? []).length;
  checks.push({ name: "sin cuadros negros", ok: blackCount === 0, detail: blackCount ? `${blackCount} tramos negros` : "ninguno" });

  const audioStats = (await exec("ffmpeg", ["-v", "info", "-i", file, "-af", "silencedetect=n=-45dB:d=2,volumedetect", "-vn", "-f", "null", "-"])).stderr;
  const silences = (audioStats.match(/silence_start/g) ?? []).length;
  checks.push({ name: "sin silencios largos", ok: silences === 0, detail: silences ? `${silences} silencios de más de 2 s` : "ninguno" });
  const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(audioStats)?.[1] ?? "0");
  checks.push({ name: "sin saturación", ok: peak < -0.1, detail: `pico ${peak} dB` });

  const ordered = timeline.captions.every((page, index) => page.endMs > page.startMs && page.startMs >= (timeline.captions[index - 1]?.startMs ?? 0) && page.endMs <= timeline.durationMs + 1);
  checks.push({ name: "subtítulos en orden", ok: ordered && timeline.captions.length > 0, detail: `${timeline.captions.length} frases` });

  const intro = timeline.scenes[0]?.content;
  const presents = intro?.type === "intro" && intro.narration.startsWith("Hola, soy Jarvis, el asistente personal de");
  const opening = intro?.type === "intro" && (intro.introduce ? presents : !presents && intro.narration.startsWith("Este mensaje es para"));
  checks.push({ name: "apertura", ok: opening, detail: intro?.type === "intro" ? `${intro.introduce ? "con presentación" : "sin presentación"}: ${intro.narration}` : "falta" });

  if (input.transcripts?.length) {
    const recall = input.transcripts.map((item) => wordRecall(item.script, item.heard));
    const average = recall.reduce((total, value) => total + value, 0) / recall.length;
    const introHeard = recall[0] ?? 0;
    checks.push({ name: "la voz dice el guion", ok: average >= 0.75 && introHeard >= 0.6, detail: `${Math.round(average * 100)}% de las palabras reconocidas; presentación ${Math.round(introHeard * 100)}%` });
  }
  return { passed: checks.every((check) => check.ok), checks };
}
