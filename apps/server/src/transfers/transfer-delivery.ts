import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
}

export type SendOutcome = { ok: true; via: "file" | "link" } | { ok: false; message: string };

export interface TransferSenderDeps {
  db: Db;
  store: TransferStore;
  attachments: AttachmentStore;
  /** Transferencias' folder. */
  dir: string;
  publicOrigin: string;
  gmail?: Pick<GmailService, "send">;
}

/** The biggest file a channel carries as it is; WhatsApp plays videos inline only up to 16 MB. */
export function channelLimit(transfer: Pick<Transfer, "mediaType">, channel: SendRequest["channel"]): number {
  if (channel === "email") return MAIL_VIDEO_BYTES;
  return transfer.mediaType.startsWith("video/") ? WHATSAPP_VIDEO_BYTES : MAX_ATTACHMENT_BYTES;
}

/**
 * Sends a Transferencias file by WhatsApp or mail: the file itself when the channel carries its
 * weight, otherwise a link to download it in original quality while the file lasts.
 */
export class TransferSender {
  constructor(private readonly deps: TransferSenderDeps) {}

  async send(transfer: Transfer, request: SendRequest, now: Date): Promise<SendOutcome> {
    const fits = transfer.size <= channelLimit(transfer, request.channel);
    const link = fits ? undefined : this.link(transfer, now);
    if (!fits && !link) return { ok: false, message: "El archivo ya no está en Transferencias." };
    const text = [request.text, link].filter(Boolean).join("\n\n");
    const via = fits ? "file" : "link";

    if (request.channel === "whatsapp") {
      const attachmentId = fits ? this.attach(transfer, now) : undefined;
      if (fits && !attachmentId) return { ok: false, message: "El archivo ya no está en Transferencias." };
      new WhatsAppOutbox(this.deps.db).enqueue({ id: randomUUID(), chatJid: request.to, text, ...(attachmentId ? { attachmentId } : {}) }, now);
      return { ok: true, via };
    }

    if (!this.deps.gmail) return { ok: false, message: "Gmail no está configurado en el servidor." };
    try {
      await this.deps.gmail.send(request.account ?? "personal", {
        to: [request.to],
        subject: request.subject ?? transfer.name,
        body: text || transfer.name,
        files: fits ? [{ name: transfer.name, mediaType: transfer.mediaType, data: readFileSync(join(this.deps.dir, transfer.uploadId)) }] : [],
      });
      return { ok: true, via };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "No pude mandar el mail." };
    }
  }

  private attach(transfer: Transfer, now: Date): string | undefined {
    try {
      const data = readFileSync(join(this.deps.dir, transfer.uploadId));
      return this.deps.attachments.save({ name: transfer.name, mediaType: transfer.mediaType, data }, now)?.id;
    } catch {
      return undefined;
    }
  }

  private link(transfer: Transfer, now: Date): string | undefined {
    const shared = this.deps.store.createShareLink(transfer.id, now);
    if (!shared) return undefined;
    const hours = Math.max(1, Math.round((Date.parse(shared.expiresAt) - now.getTime()) / 3_600_000));
    return `«${transfer.name}» en calidad original: ${transferUrls(this.deps.publicOrigin).share(shared.token)} (se puede bajar durante ${hours} h)`;
  }
}
