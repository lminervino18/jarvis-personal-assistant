import { MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentStore } from "../attachments/attachment-store.js";
import type { TokenCipher } from "../crypto/token-cipher.js";
import type { Db } from "../db/database.js";
import { MEDIA_LOCATOR_CONTEXT, type WaMediaInfo } from "../integrations/whatsapp/message-store.js";

/** Largest WhatsApp file JARVIS downloads (videos and documents can be much bigger on WhatsApp). */
export const MAX_WHATSAPP_FILE_BYTES = MAX_ATTACHMENT_BYTES;

export type MediaLocator = WaMediaInfo["locator"];

/** Fetches and decrypts a file from WhatsApp's media servers; rejects past `maxBytes`. */
export type MediaDownloader = (locator: MediaLocator, kind: WaMediaInfo["kind"], maxBytes: number) => Promise<Buffer>;

export interface WhatsAppFile {
  kind: WaMediaInfo["kind"];
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  seconds: number | null;
  voiceNote: boolean;
  attachmentId: string | null;
}

export type FetchedFile =
  | { ok: true; attachment: Attachment; file: WhatsAppFile }
  | { ok: false; reason: "not_media" | "too_large" | "expired" | "failed" };

export class FileTooLargeError extends Error {}

interface MediaRow {
  kind: WaMediaInfo["kind"];
  mimetype: string | null;
  file_name: string | null;
  size: number | null;
  seconds: number | null;
  voice_note: number;
  locator_enc: string;
  attachment_id: string | null;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
};

const KIND_NAMES: Record<WaMediaInfo["kind"], string> = { image: "foto", video: "video", audio: "audio", document: "documento", sticker: "sticker" };

function fileNameFor(row: MediaRow, messageId: string): string {
  if (row.file_name) return row.file_name;
  const type = row.mimetype?.split(";")[0]?.trim().toLowerCase() ?? "";
  return `${KIND_NAMES[row.kind]}-${messageId.slice(0, 8).toLowerCase()}.${EXTENSIONS[type] ?? "bin"}`;
}

function statusOf(error: unknown): number | undefined {
  const boom = error as { output?: { statusCode?: number }; status?: number } | undefined;
  return boom?.output?.statusCode ?? boom?.status;
}

/**
 * Files people send the owner on WhatsApp. Only a decryption key and a CDN path are kept when a
 * message arrives; the file is downloaded the first time the owner asks for it and then kept as a
 * chat attachment, so it can be read, forwarded or shared like anything the owner attached.
 */
export class WhatsAppFiles {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
    private readonly attachments: AttachmentStore,
    private readonly download: MediaDownloader,
  ) {}

  describe(chatJid: string, messageId: string): WhatsAppFile | undefined {
    const row = this.row(chatJid, messageId);
    return row
      ? { kind: row.kind, mimetype: row.mimetype, fileName: row.file_name, size: row.size, seconds: row.seconds, voiceNote: row.voice_note === 1, attachmentId: row.attachment_id }
      : undefined;
  }

  async fetch(chatJid: string, messageId: string, now: Date): Promise<FetchedFile> {
    const row = this.row(chatJid, messageId);
    const file = this.describe(chatJid, messageId);
    if (!row || !file) return { ok: false, reason: "not_media" };
    const kept = row.attachment_id ? this.attachments.get(row.attachment_id) : undefined;
    if (kept && this.attachments.read(kept.id)) return { ok: true, attachment: kept, file };
    if (row.size !== null && row.size > MAX_WHATSAPP_FILE_BYTES) return { ok: false, reason: "too_large" };
    let data: Buffer;
    try {
      const locator = JSON.parse(this.cipher.decrypt(row.locator_enc, MEDIA_LOCATOR_CONTEXT)) as MediaLocator;
      data = await this.download(locator, row.kind, MAX_WHATSAPP_FILE_BYTES);
    } catch (error) {
      if (error instanceof FileTooLargeError) return { ok: false, reason: "too_large" };
      const status = statusOf(error);
      return { ok: false, reason: status === 404 || status === 410 ? "expired" : "failed" };
    }
    const mediaType = row.mimetype?.split(";")[0]?.trim() || "application/octet-stream";
    const attachment = this.attachments.save({ name: fileNameFor(row, messageId), mediaType, data }, now, MAX_WHATSAPP_FILE_BYTES);
    if (!attachment) return { ok: false, reason: "too_large" };
    this.db.prepare("UPDATE wa_media SET attachment_id = ? WHERE chat_jid = ? AND message_id = ?").run(attachment.id, chatJid, messageId);
    return { ok: true, attachment, file: { ...file, attachmentId: attachment.id } };
  }

  private row(chatJid: string, messageId: string): MediaRow | undefined {
    return this.db
      .prepare("SELECT kind, mimetype, file_name, size, seconds, voice_note, locator_enc, attachment_id FROM wa_media WHERE chat_jid = ? AND message_id = ?")
      .get(chatJid, messageId) as MediaRow | undefined;
  }
}

/** Downloads with Baileys' media decryption; nothing is sent to the sender or the owner's phone. */
export const baileysDownload: MediaDownloader = async (locator, kind, maxBytes) => {
  const { downloadContentFromMessage } = await import("baileys");
  const stream = await downloadContentFromMessage(
    { mediaKey: Buffer.from(locator.mediaKey, "base64"), directPath: locator.directPath ?? undefined, url: locator.url ?? undefined },
    kind,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new FileTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
