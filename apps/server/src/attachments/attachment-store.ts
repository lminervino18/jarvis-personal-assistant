import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, RuntimeFile } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import { safeFileName } from "../tasks/workspace.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Types the model can look at: photos it sees as images, PDFs it reads as documents. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["application/pdf"]);
const MAX_MODEL_FILE_BYTES = 5 * 1024 * 1024;

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
}

/** Whether the model can receive this attachment as an image or a document. */
export function modelReadable(attachment: Attachment): boolean {
  return (IMAGE_TYPES.has(attachment.mediaType) || DOCUMENT_TYPES.has(attachment.mediaType)) && attachment.size <= MAX_MODEL_FILE_BYTES;
}

/**
 * Files the owner attaches in the chat (photos, PDFs, documents). They live with the personal
 * data, not in the agents' work volume; a task only gets a copy when the owner hands it over.
 */
export class AttachmentStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  save(input: { name: string; mediaType: string; data: Buffer }, now: Date): Attachment | undefined {
    if (input.data.length === 0 || input.data.length > MAX_ATTACHMENT_BYTES) return undefined;
    const attachment: Attachment = {
      id: randomUUID(),
      name: safeFileName(input.name),
      mediaType: input.mediaType.toLowerCase().slice(0, 100),
      size: input.data.length,
      createdAt: now.toISOString(),
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(attachment.id), input.data, { mode: 0o600 });
    this.db
      .prepare("INSERT INTO attachments (id, name, media_type, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(attachment.id, attachment.name, attachment.mediaType, attachment.size, createHash("sha256").update(input.data).digest("hex"), attachment.createdAt);
    return attachment;
  }

  get(id: string): Attachment | undefined {
    const row = this.db.prepare("SELECT id, name, media_type, size, created_at FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row ? { id: row.id, name: row.name, mediaType: row.media_type, size: row.size, createdAt: row.created_at } : undefined;
  }

  read(id: string): { attachment: Attachment; data: Buffer } | undefined {
    const attachment = this.get(id);
    if (!attachment || !existsSync(this.path(id))) return undefined;
    return { attachment, data: readFileSync(this.path(id)) };
  }

  card(attachment: Attachment): Extract<Card, { kind: "attachment" }> {
    return { kind: "attachment", attachmentId: attachment.id, name: attachment.name, mediaType: attachment.mediaType, size: attachment.size };
  }

  /** The attachment as the model receives it, when it is an image or a PDF small enough. */
  modelFile(attachment: Attachment): RuntimeFile | undefined {
    if (!modelReadable(attachment)) return undefined;
    const stored = this.read(attachment.id);
    return stored ? { mediaType: attachment.mediaType, data: stored.data.toString("base64") } : undefined;
  }

  private path(id: string): string {
    return join(this.dir, id);
  }
}
