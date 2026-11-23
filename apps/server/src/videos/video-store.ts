import { randomUUID } from "node:crypto";
import { VideoBrief, type VideoCard, type VideoFile, type VideoStatus } from "@jarvis/contracts";
import type { VideoTimeline } from "@jarvis/video/timeline";
import type { Db } from "../db/database.js";

export const MAX_RENDER_ATTEMPTS = 2;
const WORKING: readonly VideoStatus[] = ["voice", "render", "verify"];
const TERMINAL: readonly VideoStatus[] = ["ready", "failed", "cancelled"];

export interface VideoFiles {
  full?: VideoFile;
  light?: VideoFile;
  thumbnail?: string;
  srt?: string;
  vtt?: string;
}

export interface VideoQa {
  passed: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface VideoUsage {
  ttsCharacters: number;
  ttsCachedCharacters: number;
  renderSeconds: number;
  bytes: number;
}

export interface Video {
  id: string;
  title: string;
  ownerName: string;
  currentVersion: number;
  pageSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VideoVersion {
  videoId: string;
  version: number;
  brief: VideoBrief;
  status: VideoStatus;
  progress: number;
  attempts: number;
  timeline?: VideoTimeline;
  durationMs?: number;
  files: VideoFiles;
  qa?: VideoQa;
  usage?: VideoUsage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoDelivery {
  id: string;
  videoId: string;
  version: number;
  channel: "whatsapp" | "email";
  recipient: string;
  file: "full" | "light" | "link";
  status: "queued" | "sent" | "failed";
  providerId: string | null;
  createdAt: string;
}

interface VideoRow {
  id: string;
  title: string;
  owner_name: string;
  current_version: number;
  page_slug: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  video_id: string;
  version: number;
  brief_json: string;
  status: VideoStatus;
  progress: number;
  attempts: number;
  timeline_json: string | null;
  duration_ms: number | null;
  files_json: string;
  qa_json: string | null;
  usage_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  video_id: string;
  version: number;
  channel: VideoDelivery["channel"];
  recipient: string;
  file: VideoDelivery["file"];
  status: VideoDelivery["status"];
  provider_id: string | null;
  created_at: string;
}

function toVideo(row: VideoRow): Video {
  return {
    id: row.id,
    title: row.title,
    ownerName: row.owner_name,
    currentVersion: row.current_version,
    pageSlug: row.page_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: VersionRow): VideoVersion {
  return {
    videoId: row.video_id,
    version: row.version,
    brief: VideoBrief.parse(JSON.parse(row.brief_json)),
    status: row.status,
    progress: row.progress,
    attempts: row.attempts,
    ...(row.timeline_json ? { timeline: JSON.parse(row.timeline_json) as VideoTimeline } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    files: JSON.parse(row.files_json) as VideoFiles,
    ...(row.qa_json ? { qa: JSON.parse(row.qa_json) as VideoQa } : {}),
    ...(row.usage_json ? { usage: JSON.parse(row.usage_json) as VideoUsage } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDelivery(row: DeliveryRow): VideoDelivery {
  return {
    id: row.id,
    videoId: row.video_id,
    version: row.version,
    channel: row.channel,
    recipient: row.recipient,
    file: row.file,
    status: row.status,
    providerId: row.provider_id,
    createdAt: row.created_at,
  };
}

/** Videos and their versions: every revision is a new version, and only the newest one keeps working. */
export class VideoStore {
  constructor(private readonly db: Db) {}

  create(brief: VideoBrief, ownerName: string, now: Date): VideoVersion {
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO videos (id, title, owner_name, current_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
        .run(id, brief.title, ownerName, at, at);
      this.insertVersion(id, 1, brief, at);
    })();
    return this.require(id, 1);
  }

  revise(videoId: string, brief: VideoBrief, now: Date): VideoVersion | undefined {
    const video = this.get(videoId);
    if (!video) return undefined;
    const version = video.currentVersion + 1;
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE video_versions SET status = 'cancelled', updated_at = ? WHERE video_id = ? AND status IN ('queued', 'voice', 'render', 'verify')`)
        .run(at, videoId);
      this.insertVersion(videoId, version, brief, at);
      this.db.prepare("UPDATE videos SET title = ?, current_version = ?, updated_at = ? WHERE id = ?").run(brief.title, version, at, videoId);
    })();
    return this.require(videoId, version);
  }

  get(videoId: string): Video | undefined {
    const row = this.db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) as VideoRow | undefined;
    return row ? toVideo(row) : undefined;
  }

  version(videoId: string, version?: number): VideoVersion | undefined {
    const number = version ?? this.get(videoId)?.currentVersion;
    if (number === undefined) return undefined;
    const row = this.db.prepare("SELECT * FROM video_versions WHERE video_id = ? AND version = ?").get(videoId, number) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  /** The newest version that finished, which is the one to share while a revision is in progress. */
  latestReady(videoId: string): VideoVersion | undefined {
    const row = this.db
      .prepare("SELECT * FROM video_versions WHERE video_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1")
      .get(videoId) as VersionRow | undefined;
    return row ? toVersion(row) : undefined;
  }

  list(limit: number): (Video & { status: VideoStatus; durationMs?: number })[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, vv.status AS status, vv.duration_ms AS duration_ms FROM videos v
         JOIN video_versions vv ON vv.video_id = v.id AND vv.version = v.current_version
         ORDER BY v.updated_at DESC LIMIT ?`,
      )
      .all(limit) as (VideoRow & { status: VideoStatus; duration_ms: number | null })[];
    return rows.map((row) => ({ ...toVideo(row), status: row.status, ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}) }));
  }

  /** Takes the oldest queued version, or one whose worker died mid-way, under a lease. */
  claimNext(now: Date, leaseMs: number): VideoVersion | undefined {
    const at = now.toISOString();
    const lease = new Date(now.getTime() + leaseMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM video_versions
           WHERE status = 'queued' OR (status IN ('voice', 'render', 'verify') AND lease_until < ?)
           ORDER BY created_at LIMIT 1`,
        )
        .get(at) as VersionRow | undefined;
      if (!row) return undefined;
      if (row.attempts >= MAX_RENDER_ATTEMPTS) {
        this.db
          .prepare("UPDATE video_versions SET status = 'failed', error = ?, updated_at = ? WHERE video_id = ? AND version = ?")
          .run("Se cortó varias veces mientras se armaba.", at, row.video_id, row.version);
        return undefined;
      }
      this.db
        .prepare("UPDATE video_versions SET status = 'voice', progress = 0.02, attempts = attempts + 1, lease_until = ?, error = NULL, updated_at = ? WHERE video_id = ? AND version = ?")
        .run(lease, at, row.video_id, row.version);
      return this.require(row.video_id, row.version);
    })();
  }

  /** Moves a working version forward; returns false when it was cancelled meanwhile. */
  stage(videoId: string, version: number, status: VideoStatus, progress: number, now: Date, leaseMs: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE video_versions SET status = ?, progress = ?, lease_until = ?, updated_at = ?
         WHERE video_id = ? AND version = ? AND status IN ('voice', 'render', 'verify')`,
      )
      .run(status, Math.min(Math.max(progress, 0), 1), new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), videoId, version);
    return result.changes > 0;
  }

  saveTimeline(videoId: string, version: number, timeline: VideoTimeline, now: Date): void {
    this.db
      .prepare("UPDATE video_versions SET timeline_json = ?, duration_ms = ?, updated_at = ? WHERE video_id = ? AND version = ?")
      .run(JSON.stringify(timeline), Math.round(timeline.durationMs), now.toISOString(), videoId, version);
  }

  finish(videoId: string, version: number, result: { files: VideoFiles; qa: VideoQa; usage: VideoUsage }, now: Date): boolean {
    const changes = this.db
      .prepare(
        `UPDATE video_versions SET status = 'ready', progress = 1, files_json = ?, qa_json = ?, usage_json = ?, lease_until = NULL, updated_at = ?
         WHERE video_id = ? AND version = ? AND status IN ('voice', 'render', 'verify')`,
      )
      .run(JSON.stringify(result.files), JSON.stringify(result.qa), JSON.stringify(result.usage), now.toISOString(), videoId, version).changes;
    if (changes) this.touch(videoId, now);
    return changes > 0;
  }

  /** Records a failure: retryable ones go back to the queue while attempts remain. */
  fail(videoId: string, version: number, error: string, retry: boolean, now: Date): VideoStatus | undefined {
    const current = this.version(videoId, version);
    if (!current || TERMINAL.includes(current.status)) return current?.status;
    const status: VideoStatus = retry && current.attempts < MAX_RENDER_ATTEMPTS ? "queued" : "failed";
    this.db
      .prepare("UPDATE video_versions SET status = ?, error = ?, lease_until = NULL, updated_at = ? WHERE video_id = ? AND version = ?")
      .run(status, error.slice(0, 300), now.toISOString(), videoId, version);
    this.touch(videoId, now);
    return status;
  }

  isWorking(videoId: string, version: number): boolean {
    return WORKING.includes(this.version(videoId, version)?.status ?? "cancelled");
  }

  setPageSlug(videoId: string, slug: string, now: Date): void {
    this.db.prepare("UPDATE videos SET page_slug = ?, updated_at = ? WHERE id = ?").run(slug, now.toISOString(), videoId);
  }

  card(videoId: string, version?: number): VideoCard | undefined {
    const video = this.get(videoId);
    const current = this.version(videoId, version);
    if (!video || !current) return undefined;
    return {
      kind: "video",
      videoId,
      version: current.version,
      title: current.brief.title,
      format: current.brief.format,
      status: current.status,
      progress: current.progress,
      ...(current.durationMs !== undefined ? { durationMs: current.durationMs } : {}),
      files: current.files,
      ...(current.error ? { error: current.error } : {}),
      updatedAt: current.updatedAt,
    };
  }

  findDelivery(dedupeKey: string): VideoDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM video_deliveries WHERE dedupe_key = ?").get(dedupeKey) as DeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  addDelivery(input: Omit<VideoDelivery, "id" | "createdAt"> & { dedupeKey: string }, now: Date): VideoDelivery {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO video_deliveries (id, video_id, version, channel, recipient, file, status, provider_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.videoId, input.version, input.channel, input.recipient, input.file, input.status, input.providerId, input.dedupeKey, now.toISOString());
    return toDelivery(this.db.prepare("SELECT * FROM video_deliveries WHERE id = ?").get(id) as DeliveryRow);
  }

  deliveries(videoId: string): VideoDelivery[] {
    return (this.db.prepare("SELECT * FROM video_deliveries WHERE video_id = ? ORDER BY created_at").all(videoId) as DeliveryRow[]).map(toDelivery);
  }

  private insertVersion(videoId: string, version: number, brief: VideoBrief, at: string): void {
    this.db
      .prepare("INSERT INTO video_versions (video_id, version, brief_json, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(videoId, version, JSON.stringify(brief), at, at);
  }

  private touch(videoId: string, now: Date): void {
    this.db.prepare("UPDATE videos SET updated_at = ? WHERE id = ?").run(now.toISOString(), videoId);
  }

  private require(videoId: string, version: number): VideoVersion {
    const found = this.version(videoId, version);
    if (!found) throw new Error("video version not found");
    return found;
  }
}
