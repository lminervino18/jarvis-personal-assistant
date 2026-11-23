import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeFile } from "@jarvis/contracts";
import { unzipSync, strFromU8 } from "fflate";
import readXlsxFile from "read-excel-file/node";
import { transcribeAudioFile, type AudioFileTranscriber } from "../voice/audio-file-transcription.js";

const run = promisify(execFile);

const MAX_TEXT_CHARS = 30_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SHEETS = 5;
const MAX_ROWS_PER_SHEET = 300;
const VIDEO_FRAMES = 4;
const TOOL_TIMEOUT_MS = 60_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "json", "md", "xml", "html", "htm", "log", "vcf", "ics"]);

export interface FileToAnalyze {
  name: string;
  mediaType: string;
  data: Buffer;
}

/** What the model gets from a file: readable text, images to look at, or a note on what could not be read. */
export interface FileAnalysis {
  text?: string;
  images: RuntimeFile[];
  note?: string;
}

export interface FileAnalysisDeps {
  stt?: AudioFileTranscriber;
  /** Runs ffmpeg, ffprobe and pdftotext; replaced in tests. */
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>;
}

function extension(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

function clip(text: string): string {
  const clean = text.replaceAll("\u0000", "").trim();
  return clean.length > MAX_TEXT_CHARS ? `${clean.slice(0, MAX_TEXT_CHARS)}\n[…recortado]` : clean;
}

type FileFamily = "image" | "audio" | "video" | "pdf" | "text" | "spreadsheet" | "word" | "other";

/** What kind of file this is, by media type and, when that is generic, by extension. */
export function fileFamily(file: Pick<FileToAnalyze, "name" | "mediaType">): FileFamily {
  const type = file.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = extension(file.name);
  if (IMAGE_TYPES.has(type)) return "image";
  if (type.startsWith("audio/") || ["ogg", "opus", "m4a", "mp3", "wav", "aac"].includes(ext)) return "audio";
  if (type.startsWith("video/") || ["mp4", "mov", "webm", "3gp"].includes(ext)) return "video";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "xlsx" || type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "spreadsheet";
  if (ext === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "word";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}

async function defaultExec(command: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await run(command, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { stdout };
}

async function withTempFile<T>(file: FileToAnalyze, work: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-file-"));
  try {
    const path = join(dir, `input.${extension(file.name) || "bin"}`);
    await writeFile(path, file.data, { mode: 0o600 });
    return await work(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function spreadsheet(file: FileToAnalyze): Promise<string> {
  const sheets = (await readXlsxFile(file.data)).slice(0, MAX_SHEETS);
  return sheets
    .map(({ sheet, data }) => {
      const shown = data.slice(0, MAX_ROWS_PER_SHEET).map((row) => row.map((cell) => (cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? ""))).join(" | "));
      const more = data.length > MAX_ROWS_PER_SHEET ? `\n[…${data.length - MAX_ROWS_PER_SHEET} filas más]` : "";
      return `Hoja «${sheet}» (${data.length} filas):\n${shown.join("\n")}${more}`;
    })
    .join("\n\n");
}

function wordText(data: Buffer): string {
  const files = unzipSync(new Uint8Array(data), { filter: (entry) => entry.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) return "";
  return strFromU8(xml)
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function videoAnalysis(file: FileToAnalyze, deps: Required<Pick<FileAnalysisDeps, "exec">> & FileAnalysisDeps): Promise<FileAnalysis> {
  return withTempFile(file, async (path, dir) => {
    const probe = await deps.exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
    const duration = Math.max(0, Number.parseFloat(probe.stdout) || 0);
    const images: RuntimeFile[] = [];
    for (let index = 0; index < VIDEO_FRAMES; index++) {
      const frame = join(dir, `frame-${index}.jpg`);
      const at = duration > 0 ? (duration * (index + 0.5)) / VIDEO_FRAMES : index;
      await deps.exec("ffmpeg", ["-v", "error", "-ss", at.toFixed(2), "-i", path, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "5", "-y", frame]).catch(() => undefined);
      const bytes = await readFile(frame).catch(() => undefined);
      if (bytes?.length) images.push({ mediaType: "image/jpeg", data: bytes.toString("base64") });
    }
    const audioPath = join(dir, "audio.ogg");
    const extracted = await deps.exec("ffmpeg", ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-y", audioPath]).then(() => true, () => false);
    const audio = extracted ? await readFile(audioPath).catch(() => undefined) : undefined;
    const transcript = audio?.length ? await transcribeAudioFile(deps.stt, { data: audio, mediaType: "audio/ogg" }) : undefined;
    const spoken = transcript?.ok && transcript.text ? `Lo que se dice en el video: ${transcript.text}` : "El video no tiene habla que se pueda transcribir.";
    return { images, text: `Video de ${Math.round(duration)} s; te paso ${images.length} cuadros repartidos. ${spoken}` };
  });
}

/**
 * Turns any file into something the model can read: photos as images, audio as a transcript,
 * video as a few frames plus the transcript of its sound, PDFs, Word, Excel and text files as text.
 * Anything else gets a note; it can still be forwarded or shared as is.
 */
export async function analyzeFile(file: FileToAnalyze, deps: FileAnalysisDeps = {}): Promise<FileAnalysis> {
  const exec = deps.exec ?? defaultExec;
  try {
    switch (fileFamily(file)) {
      case "image":
        return file.data.length <= MAX_IMAGE_BYTES
          ? { images: [{ mediaType: file.mediaType.split(";")[0] as string, data: file.data.toString("base64") }] }
          : { images: [], note: "La imagen es demasiado grande para mirarla; se puede reenviar o compartir." };
      case "audio": {
        const result = await transcribeAudioFile(deps.stt, { data: file.data, mediaType: file.mediaType });
        return result.ok ? { images: [], text: `Transcripción del audio: ${result.text || "(sin habla)"}` } : { images: [], note: `No pude transcribir el audio (${result.error}).` };
      }
      case "video":
        return await videoAnalysis(file, { ...deps, exec });
      case "pdf":
        return { images: [], text: clip((await withTempFile(file, (path) => exec("pdftotext", ["-layout", "-l", "40", path, "-"]))).stdout) };
      case "spreadsheet":
        return { images: [], text: clip(await spreadsheet(file)) };
      case "word":
        return { images: [], text: clip(wordText(file.data)) };
      case "text":
        return { images: [], text: clip(file.data.toString("utf8")) };
      case "other":
        return { images: [], note: "No puedo leer este tipo de archivo por dentro; se puede reenviar o compartir igual." };
    }
  } catch {
    return { images: [], note: "No pude leer el archivo por dentro; se puede reenviar o compartir igual." };
  }
}
