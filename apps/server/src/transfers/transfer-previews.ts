import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import type { Exec } from "../videos/video-qa.js";
import type { Transfer } from "./transfer-store.js";

export type PreviewSize = "thumb" | "large";

const WIDTH: Record<PreviewSize, number> = { thumb: 480, large: 1600 };
const MAX_RUNNING = 2;
/** Some sites (X) tag videos with «reserved» colors, which ffmpeg 7 refuses to scale; the preview reads them as standard BT.709. */
const STANDARD_COLORS = "matrix_coefficients=1:colour_primaries=1:transfer_characteristics=1";
const IMAGE_NAMES = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif", ".tif", ".tiff", ".bmp"]);
const VIDEO_NAMES = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp"]);
const AUDIO_NAMES = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff"]);

export type PreviewKind = "image" | "video" | "audio";

/** How a file can be shown, by its type or, when the browser gave none, by its extension. */
export function previewKind(transfer: Pick<Transfer, "mediaType" | "name">): PreviewKind | undefined {
  for (const kind of ["image", "video", "audio"] as const) if (transfer.mediaType.startsWith(`${kind}/`)) return kind;
  const extension = extname(transfer.name).toLowerCase();
  if (IMAGE_NAMES.has(extension)) return "image";
  if (VIDEO_NAMES.has(extension)) return "video";
  if (AUDIO_NAMES.has(extension)) return "audio";
  return undefined;
}

/**
 * Small JPEG previews of photos and videos, so the owner can browse Transferencias without
 * downloading the originals. Each is made once with ffmpeg, at most two at a time, and kept until the file leaves.
 */
export class TransferPreviews {
  private readonly dir: string;
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly uploadsDir: string,
    private readonly exec: Exec,
  ) {
    this.dir = join(uploadsDir, "previews");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Path of the JPEG preview, or undefined when the file cannot be previewed. */
  get(transfer: Transfer, size: PreviewSize): Promise<string | undefined> {
    const kind = previewKind(transfer);
    if (kind !== "image" && kind !== "video") return Promise.resolve(undefined);
    const target = join(this.dir, `${transfer.uploadId}-${size}.jpg`);
    if (existsSync(target)) return Promise.resolve(target);
    const running = this.pending.get(target);
    if (running) return running;
    const made = this.slot(() => this.make(join(this.uploadsDir, transfer.uploadId), target, kind, WIDTH[size])).finally(() => this.pending.delete(target));
    this.pending.set(target, made);
    return made;
  }

  remove(uploadId: string): void {
    for (const size of Object.keys(WIDTH)) rmSync(join(this.dir, `${uploadId}-${size}.jpg`), { force: true });
  }

  private async make(source: string, target: string, kind: PreviewKind, width: number): Promise<string | undefined> {
    const scale = ["-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-y", target];
    const attempts =
      kind === "video"
        ? [
            ["-v", "error", "-ss", "1", "-i", source, ...scale],
            ["-v", "error", "-i", source, ...scale],
            ...["h264", "hevc"].map((codec) => ["-v", "error", "-bsf:v", `${codec}_metadata=${STANDARD_COLORS}`, "-ss", "1", "-i", source, ...scale]),
          ]
        : [["-v", "error", "-i", source, ...scale]];
    for (const args of attempts) {
      await this.exec("ffmpeg", args).catch(() => undefined);
      if (existsSync(target)) return target;
    }
    return undefined;
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_RUNNING) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
