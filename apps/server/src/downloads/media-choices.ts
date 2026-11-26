import { randomUUID } from "node:crypto";
import type { Card, MediaFormat } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import { watchUrl } from "../integrations/youtube/youtube-service.js";
import type { SendRequest } from "../transfers/transfer-delivery.js";
import type { MediaJob, MediaQueue } from "./media-queue.js";

type ChoiceCard = Extract<Card, { kind: "media_choice" }>;
export type ChoiceOption = ChoiceCard["options"][number];

export interface MediaChoice {
  id: string;
  query: string;
  format: MediaFormat;
  send?: SendRequest;
  options: ChoiceOption[];
  chosen?: number;
  jobId?: string;
  expiresAt: string;
}

interface Row {
  id: string;
  query: string;
  format: MediaFormat;
  send_json: string | null;
  options_json: string;
  chosen: number | null;
  job_id: string | null;
  expires_at: string;
}

/** A proposal can be answered for a day, as long as Transferencias keeps a file. */
const CHOICE_TTL_MS = 24 * 3_600_000;

function toChoice(row: Row): MediaChoice {
  return {
    id: row.id,
    query: row.query,
    format: row.format,
    ...(row.send_json ? { send: JSON.parse(row.send_json) as SendRequest } : {}),
    options: JSON.parse(row.options_json) as ChoiceOption[],
    ...(row.chosen !== null ? { chosen: row.chosen } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    expiresAt: row.expires_at,
  };
}

export type ChooseOutcome = { ok: true; choice: MediaChoice; job: MediaJob } | { ok: false; reason: "not_found" | "expired" | "chosen" | "failed"; choice?: MediaChoice };

/**
 * Videos proposed to the owner when what they asked for is not clear. The download starts with
 * the owner's tap, with the format and recipient fixed when the proposal was made.
 */
export class MediaChoices {
  constructor(
    private readonly db: Db,
    private readonly queue: MediaQueue,
  ) {}

  create(input: { query: string; format: MediaFormat; send?: SendRequest; options: ChoiceOption[] }, now: Date): MediaChoice {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO media_choices (id, query, format, send_json, options_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.query, input.format, input.send ? JSON.stringify(input.send) : null, JSON.stringify(input.options), now.toISOString(), new Date(now.getTime() + CHOICE_TTL_MS).toISOString());
    return this.get(id) as MediaChoice;
  }

  get(id: string): MediaChoice | undefined {
    const row = this.db.prepare("SELECT * FROM media_choices WHERE id = ?").get(id) as Row | undefined;
    return row ? toChoice(row) : undefined;
  }

  /** Downloads one of the options; a second tap never starts a second download. */
  choose(id: string, option: number, now: Date): ChooseOutcome {
    const choice = this.get(id);
    const picked = choice?.options[option];
    if (!choice || !picked) return { ok: false, reason: "not_found" };
    if (choice.chosen !== undefined) return { ok: false, reason: "chosen", choice };
    if (Date.parse(choice.expiresAt) <= now.getTime()) return { ok: false, reason: "expired", choice };
    const claimed = this.db.prepare("UPDATE media_choices SET chosen = ? WHERE id = ? AND chosen IS NULL").run(option, id).changes;
    if (claimed === 0) return { ok: false, reason: "chosen", choice: this.get(id) };
    const job = this.queue.download({ url: watchUrl(picked.videoId), format: choice.format, ...(choice.send ? { send: choice.send } : {}) });
    if (!job) {
      this.db.prepare("UPDATE media_choices SET chosen = NULL WHERE id = ?").run(id);
      return { ok: false, reason: "failed", choice };
    }
    this.db.prepare("UPDATE media_choices SET job_id = ? WHERE id = ?").run(job.id, id);
    return { ok: true, choice: this.get(id) as MediaChoice, job };
  }

  card(choice: MediaChoice): ChoiceCard {
    return {
      kind: "media_choice",
      choiceId: choice.id,
      format: choice.format,
      ...(choice.send ? { sendTo: choice.send.name } : {}),
      options: choice.options,
      ...(choice.chosen !== undefined ? { chosen: choice.chosen } : {}),
      expiresAt: choice.expiresAt,
    };
  }
}
