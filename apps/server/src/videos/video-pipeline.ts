import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTimeline, introNarration, toSrt, toVtt, type NarratedSegment, type VideoTimeline } from "@jarvis/video/timeline";
import type { AttachmentStore } from "../attachments/attachment-store.js";
import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE } from "../push/notification.js";
import { transcribeAudioFile, type AudioFileTranscriber } from "../voice/audio-file-transcription.js";
import { Outbox } from "../worker/outbox.js";
import type { Narrator } from "./narrator.js";
import { formatDuration, versionDir } from "./video-paths.js";
import { checkVideo, fastStart, lightVersion, thumbnail, type Exec } from "./video-qa.js";
import { renderVideo, serveFolder } from "./video-render.js";
import type { VideoFiles, VideoStore, VideoUsage, VideoVersion } from "./video-store.js";

export const LEASE_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 20 * 60_000;

export interface PipelineDeps {
  db: Db;
  store: VideoStore;
  attachments: AttachmentStore;
  narrator: Narrator;
  stt?: AudioFileTranscriber;
  exec: Exec;
  bundleDir: string;
  /** Where each version keeps its narration and timeline: `<videosDir>/<id>/v<version>`. */
  videosDir: string;
  log: { info(data: object, message: string): void; warn(data: object, message: string): void };
  render?: typeof renderVideo;
  now?: () => Date;
}

/** A failure the owner can fix by changing the brief; retrying would fail the same way. */
export class BriefError extends Error {}

function fileSlug(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "video"
  );
}

/** Turns a queued version into a finished, verified video: voice, timeline, render, files, checks. */
export class VideoPipeline {
  private readonly now: () => Date;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(version: VideoVersion): Promise<void> {
    const { videoId } = version;
    const started = Date.now();
    const dir = versionDir(this.deps.videosDir, videoId, version.version);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const narrated = await this.narrate(version, dir);
      const timeline = this.timeline(version, dir, narrated.segments);
      this.deps.store.saveTimeline(videoId, version.version, timeline, this.now());
      writeFileSync(join(dir, "timeline.json"), JSON.stringify(timeline));
      if (!this.advance(version, "render", 0.4)) return;
      const raw = join(dir, "render.mp4");
      await this.render(version, dir, timeline, raw);
      if (!this.advance(version, "verify", 0.88)) return;
      const files = await this.finishFiles(version, dir, timeline, raw);
      const transcripts = await this.transcripts(narrated.segments, dir);
      const qa = await checkVideo({ exec: this.deps.exec, file: join(dir, "final.mp4"), timeline, ...(transcripts ? { transcripts } : {}) });
      if (!qa.passed) {
        const failed = qa.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
        throw new BriefError(`No pasó el control de calidad (${failed.join("; ")}).`);
      }
      const saved = this.saveFiles(version, dir, files);
      const usage: VideoUsage = {
        ttsCharacters: narrated.characters,
        ttsCachedCharacters: narrated.cachedCharacters,
        renderSeconds: Math.round((Date.now() - started) / 1000),
        bytes: saved.full?.size ?? 0,
      };
      if (this.deps.store.finish(videoId, version.version, { files: saved, qa, usage }, this.now())) this.notifyReady(version, timeline.durationMs);
      this.deps.log.info({ videoId, version: version.version, ...usage }, "video ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "error desconocido";
      const status = this.deps.store.fail(videoId, version.version, message, !(error instanceof BriefError), this.now());
      this.deps.log.warn({ videoId, version: version.version, status, err: message.slice(0, 200) }, "video failed");
      if (status === "failed") this.notifyFailed(version, message);
    } finally {
      for (const name of ["render.mp4", "final.mp4", "light.mp4"]) rmSync(join(dir, name), { force: true });
    }
  }

  private advance(version: VideoVersion, status: "voice" | "render" | "verify", progress: number): boolean {
    return this.deps.store.stage(version.videoId, version.version, status, progress, this.now(), LEASE_MS);
  }

  private async narrate(version: VideoVersion, dir: string): Promise<{ segments: NarratedSegment[]; characters: number; cachedCharacters: number }> {
    const owner = this.deps.store.get(version.videoId)?.ownerName ?? "";
    const texts = [introNarration(owner, version.brief.purpose), ...version.brief.scenes.map((scene) => scene.narration)];
    const segments: NarratedSegment[] = [];
    let characters = 0;
    let cachedCharacters = 0;
    for (const [index, text] of texts.entries()) {
      const narration = await this.deps.narrator.narrate(text);
      copyFileSync(narration.path, join(dir, narration.file));
      segments.push({ text, file: narration.file, durationMs: narration.durationMs, words: narration.words });
      characters += narration.characters;
      if (narration.cached) cachedCharacters += narration.characters;
      if (!this.advance(version, "voice", 0.05 + (0.3 * (index + 1)) / texts.length)) throw new Error("cancelled");
    }
    return { segments, characters, cachedCharacters };
  }

  private timeline(version: VideoVersion, dir: string, segments: NarratedSegment[]): VideoTimeline {
    const { brief } = version;
    const owner = this.deps.store.get(version.videoId)?.ownerName ?? "";
    const media: Record<string, { file: string; kind: "image" | "video" }> = {};
    for (const scene of brief.scenes) {
      if (scene.type !== "media" || media[scene.attachmentId]) continue;
      const stored = this.deps.attachments.read(scene.attachmentId);
      const kind = stored?.attachment.mediaType.startsWith("image/") ? "image" : stored?.attachment.mediaType.startsWith("video/") ? "video" : undefined;
      if (!stored || !kind) throw new BriefError("Una escena usa un archivo que no existe o que no es una foto ni un video.");
      const extension = stored.attachment.name.split(".").pop()?.toLowerCase() ?? (kind === "image" ? "jpg" : "mp4");
      const file = `media-${scene.attachmentId}.${extension}`;
      writeFileSync(join(dir, file), stored.data, { mode: 0o600 });
      media[scene.attachmentId] = { file, kind };
    }
    const intro = { type: "intro" as const, owner, purpose: brief.purpose.replace(/^para\s+/i, "").replace(/[.\s]+$/, ""), narration: segments[0]?.text ?? "" };
    return buildTimeline({ format: brief.format, intro, scenes: brief.scenes, segments, media });
  }

  private async render(version: VideoVersion, dir: string, timeline: VideoTimeline, output: string): Promise<void> {
    const server = await serveFolder(dir);
    try {
      let last = 0;
      await (this.deps.render ?? renderVideo)({
        bundleDir: this.deps.bundleDir,
        timeline: { ...timeline, assetBase: server.url },
        output,
        timeoutMs: RENDER_TIMEOUT_MS,
        onProgress: (progress) => {
          if (progress - last < 0.05) return;
          last = progress;
          this.advance(version, "render", 0.4 + progress * 0.45);
        },
        shouldStop: () => !this.deps.store.isWorking(version.videoId, version.version),
      });
    } finally {
      await server.close();
    }
  }

  private async finishFiles(version: VideoVersion, dir: string, timeline: VideoTimeline, raw: string) {
    const vertical = version.brief.format === "vertical";
    const final = join(dir, "final.mp4");
    await fastStart(this.deps.exec, raw, final);
    await lightVersion(this.deps.exec, final, join(dir, "light.mp4"), vertical);
    const cover = timeline.scenes[1] ?? timeline.scenes[0];
    const coverAt = cover ? cover.startMs + Math.min(cover.durationMs - 400, cover.audio.startMs + 1800) : 1000;
    await thumbnail(this.deps.exec, final, join(dir, "thumbnail.jpg"), coverAt);
    writeFileSync(join(dir, "subtitles.srt"), toSrt(timeline.captions));
    writeFileSync(join(dir, "subtitles.vtt"), toVtt(timeline.captions));
    return { final, light: join(dir, "light.mp4"), thumbnail: join(dir, "thumbnail.jpg"), srt: join(dir, "subtitles.srt"), vtt: join(dir, "subtitles.vtt") };
  }

  private async transcripts(segments: NarratedSegment[], dir: string): Promise<{ script: string; heard: string }[] | undefined> {
    if (!this.deps.stt) return undefined;
    const result: { script: string; heard: string }[] = [];
    for (const segment of segments) {
      const heard = await transcribeAudioFile(this.deps.stt, { data: readFileSync(join(dir, segment.file)), mediaType: "audio/wav" });
      if (!heard.ok) return undefined;
      result.push({ script: segment.text, heard: heard.text });
    }
    return result;
  }

  private saveFiles(version: VideoVersion, dir: string, paths: Awaited<ReturnType<VideoPipeline["finishFiles"]>>): VideoFiles {
    const now = this.now();
    const slug = fileSlug(version.brief.title);
    const save = (path: string, name: string, mediaType: string) => {
      const saved = this.deps.attachments.save({ name, mediaType, data: readFileSync(path) }, now);
      if (!saved) throw new BriefError(`El archivo ${name} pesa más de lo que JARVIS guarda (${Math.round(statSync(path).size / 1048576)} MB).`);
      return saved;
    };
    const full = save(paths.final, `${slug}.mp4`, "video/mp4");
    const light = save(paths.light, `${slug}-liviano.mp4`, "video/mp4");
    const files: VideoFiles = {
      full: { attachmentId: full.id, size: full.size },
      light: { attachmentId: light.id, size: light.size },
      thumbnail: save(paths.thumbnail, `${slug}.jpg`, "image/jpeg").id,
      srt: save(paths.srt, `${slug}.srt`, "application/x-subrip").id,
      vtt: save(paths.vtt, `${slug}.vtt`, "text/vtt").id,
    };
    return files;
  }

  private notifyReady(version: VideoVersion, durationMs: number): void {
    const card = this.deps.store.card(version.videoId, version.version);
    const send = this.deps.store.get(version.videoId)?.send;
    const next = send?.status === "pending" ? `Se lo mando a ${send.recipient} por ${send.channel === "email" ? "mail" : "WhatsApp"}.` : "Miralo en la tarjeta; para mandarlo, decime a quién.";
    const text = `Listo el video «${version.brief.title}» (${formatDuration(durationMs)}). ${next}`;
    this.notify(version, "ready", text, card ? [card] : []);
  }

  private notifyFailed(version: VideoVersion, error: string): void {
    const card = this.deps.store.card(version.videoId, version.version);
    this.notify(version, "failed", `No pude terminar el video «${version.brief.title}»: ${error}`, card ? [card] : []);
  }

  private notify(version: VideoVersion, outcome: string, text: string, cards: NonNullable<ReturnType<VideoStore["card"]>>[]): void {
    const outbox = new Outbox(this.deps.db);
    const key = `video:${version.videoId}:${version.version}:${outcome}`;
    const now = this.now();
    outbox.enqueue({ kind: "chat_message", dedupeKey: `${key}:chat`, payload: { text, cards } }, now);
    outbox.enqueue({ kind: "push", dedupeKey: `${key}:push`, payload: { title: NOTIFICATION_TITLE, body: outcome === "ready" ? "Tu video está listo." : "No pude terminar un video.", tag: key, url: "/" } }, now);
  }
}
