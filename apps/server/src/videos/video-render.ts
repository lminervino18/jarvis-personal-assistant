import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join } from "node:path";
import type { VideoTimeline } from "@jarvis/video/timeline";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";

export const COMPOSITION_ID = "jarvis-video";

const TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Serves the files of one folder on 127.0.0.1 so the headless browser can load them while rendering. */
export async function serveFolder(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const name = basename(decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname));
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      response.writeHead(404).end();
      return;
    }
    const type = TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RenderRequest {
  bundleDir: string;
  timeline: VideoTimeline;
  output: string;
  timeoutMs: number;
  onProgress(progress: number): void;
  /** Checked on every progress tick; true stops the render. */
  shouldStop(): boolean;
}

/** Renders the composition to an H.264/AAC MP4 with one browser tab, so a call on the same box keeps its CPU. */
export async function renderVideo(request: RenderRequest): Promise<void> {
  const { cancelSignal, cancel } = makeCancelSignal();
  const timer = setTimeout(cancel, request.timeoutMs);
  try {
    const inputProps = request.timeline as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl: request.bundleDir, id: COMPOSITION_ID, inputProps, logLevel: "warn" });
    await renderMedia({
      composition,
      serveUrl: request.bundleDir,
      codec: "h264",
      audioCodec: "aac",
      audioBitrate: "128k",
      pixelFormat: "yuv420p",
      crf: 20,
      x264Preset: "medium",
      imageFormat: "jpeg",
      jpegQuality: 90,
      concurrency: 1,
      outputLocation: request.output,
      inputProps,
      cancelSignal,
      licenseKey: "free-license",
      logLevel: "warn",
      onProgress: ({ progress }) => {
        request.onProgress(progress);
        if (request.shouldStop()) cancel();
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
