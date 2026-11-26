import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "../attachments/attachment-store.js";
import type { Db } from "../db/database.js";
import type { GmailService } from "../integrations/gmail/gmail-service.js";
import { WhatsAppOutbox } from "../integrations/whatsapp/outbox.js";
import { MAIL_VIDEO_BYTES, WHATSAPP_VIDEO_BYTES } from "../videos/video-delivery.js";
import { transferUrls } from "./transfer-routes.js";
import type { Transfer, TransferStore } from "./transfer-store.js";

/** Who gets a file: the tools resolve the WhatsApp chat or check the address before it gets here. */
export interface SendRequest {
  channel: "whatsapp" | "email";
  /** A WhatsApp chat id, or an email address. */
  to: string;
  /** How the owner calls the recipient, for the notices. */
  name: string;
  text?: string;
  subject?: string;
  account?: "personal" | "work";
  /** A link in original quality instead of the file, because the owner asked for it. */
  asLink?: boolean;
}

export type SendOutcome = { ok: true; via: "file" | "compressed" | "link" } | { ok: false; message: string };

export interface TransferSenderDeps {
  db: Db;
  store: TransferStore;
  attachments: AttachmentStore;
  /** Transferencias' folder. */
  dir: string;
  publicOrigin: string;
  gmail?: Pick<GmailService, "send">;
  /** A copy of a video at most `targetBytes` heavy in `dir`, or undefined when it cannot fit. */
  compress?(input: string, targetBytes: number, dir: string): Promise<string | undefined>;
}

/** The biggest file a channel carries as it is; WhatsApp plays videos inline only up to 16 MB. */
export function channelLimit(transfer: Pick<Transfer, "mediaType">, channel: SendRequest["channel"]): number {
  if (channel === "email") return MAIL_VIDEO_BYTES;
  return transfer.mediaType.startsWith("video/") ? WHATSAPP_VIDEO_BYTES : MAX_ATTACHMENT_BYTES;
}

/**
 * Sends a Transferencias file by WhatsApp or mail: the file itself when the channel carries its
 * weight; a video too heavy for it, compressed until it fits; and a link to download it in original
 * quality only when the owner asked for one or nothing else fits.
 */
export class TransferSender {
  constructor(private readonly deps: TransferSenderDeps) {}

  async send(transfer: Transfer, request: SendRequest, now: Date): Promise<SendOutcome> {
    const file = request.asLink ? undefined : await this.fitting(transfer, channelLimit(transfer, request.channel));
    const link = file ? undefined : this.link(transfer, now);
    if (!file && !link) return { ok: false, message: "El archivo ya no está en Transferencias." };
    const text = [request.text, link].filter(Boolean).join("\n\n");
    const via = !file ? "link" : file.compressed ? "compressed" : "file";

    if (request.channel === "whatsapp") {
      const attachmentId = file ? this.deps.attachments.save({ name: file.name, mediaType: file.mediaType, data: file.data }, now)?.id : undefined;
      if (file && !attachmentId) return { ok: false, message: "No pude preparar el archivo para mandarlo." };
      new WhatsAppOutbox(this.deps.db).enqueue({ id: randomUUID(), chatJid: request.to, text, ...(attachmentId ? { attachmentId } : {}) }, now);
      return { ok: true, via };
    }

    if (!this.deps.gmail) return { ok: false, message: "Gmail no está configurado en el servidor." };
    try {
      await this.deps.gmail.send(request.account ?? "personal", {
        to: [request.to],
        subject: request.subject ?? transfer.name,
        body: text || transfer.name,
        files: file ? [{ name: file.name, mediaType: file.mediaType, data: file.data }] : [],
      });
      return { ok: true, via };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "No pude mandar el mail." };
    }
  }

  /** The file as the channel can carry it: as it is, or a video compressed to fit; undefined when only a link works. */
  private async fitting(transfer: Transfer, limit: number): Promise<{ name: string; mediaType: string; data: Buffer; compressed: boolean } | undefined> {
    const path = join(this.deps.dir, transfer.uploadId);
    if (!existsSync(path)) return undefined;
    if (transfer.size <= limit) return { name: transfer.name, mediaType: transfer.mediaType, data: readFileSync(path), compressed: false };
    if (!transfer.mediaType.startsWith("video/") || !this.deps.compress) return undefined;
    const work = join(this.deps.dir, "downloads", `compress-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    try {
      const compressed = await this.deps.compress(path, Math.floor(limit * 0.95), work).catch(() => undefined);
      if (!compressed) return undefined;
      return { name: `${transfer.name.replace(/\.[^.]+$/, "")}.mp4`, mediaType: "video/mp4", data: readFileSync(compressed), compressed: true };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private link(transfer: Transfer, now: Date): string | undefined {
    const shared = this.deps.store.createShareLink(transfer.id, now);
    if (!shared) return undefined;
    const hours = Math.max(1, Math.round((Date.parse(shared.expiresAt) - now.getTime()) / 3_600_000));
    return `«${transfer.name}» en calidad original: ${transferUrls(this.deps.publicOrigin).share(shared.token)} (se puede bajar durante ${hours} h)`;
  }
}
