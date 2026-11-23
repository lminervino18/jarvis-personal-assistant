import { createHash, randomUUID } from "node:crypto";
import type { ToolErrorCode } from "@jarvis/contracts";
import { WhatsAppOutbox } from "../integrations/whatsapp/outbox.js";
import { bridgeConnected } from "../integrations/whatsapp/status.js";
import type { ToolServices } from "../tools/types.js";
import type { VideoVersion } from "./video-store.js";

/** WhatsApp plays videos up to this size inline; bigger ones go lighter or as a link. */
export const WHATSAPP_VIDEO_BYTES = 16 * 1024 * 1024;
/** Gmail's limit for attachments. */
export const MAIL_VIDEO_BYTES = 20 * 1024 * 1024;
const CHANNEL_LIMIT = { whatsapp: WHATSAPP_VIDEO_BYTES, email: MAIL_VIDEO_BYTES } as const;

export type Channel = keyof typeof CHANNEL_LIMIT;
export type Delivery = { file: "full" | "light"; attachmentId: string; size: number } | { file: "link" };

/** The file a channel can carry: the full video, the light one, or only a link when both are too big. */
export function deliveryFor(version: VideoVersion, channel: Channel): Delivery {
  const limit = CHANNEL_LIMIT[channel];
  const { full, light } = version.files;
  if (full && full.size <= limit) return { file: "full", ...full };
  if (light && light.size <= limit) return { file: "light", ...light };
  return { file: "link" };
}

export interface SendInput {
  videoId: string;
  /** The exact version the owner approved; the newest ready one when absent. */
  version?: number;
  channel: Channel;
  /** A resolved chat id for WhatsApp, an address for mail. */
  to: string;
  text?: string;
  subject?: string;
  account?: "personal" | "work";
}

export type SendOutcome =
  | { ok: true; deliveryId: string; file: Delivery["file"]; status: "queued" | "sent"; repeated: boolean }
  | { ok: false; code: ToolErrorCode; message: string; retryable: boolean };

function refused(code: ToolErrorCode, message: string, retryable = false): SendOutcome {
  return { ok: false, code, message, retryable };
}

/**
 * Sends a ready video once: picks the file the channel carries, adds the interactive page and a
 * 7-day link when needed, records the delivery, and never repeats the same send.
 */
export async function sendVideo(services: ToolServices, input: SendInput, now: Date): Promise<SendOutcome> {
  const store = services.videos;
  if (!store) return refused("disabled", "Los videos no están configurados en el servidor.");
  const video = store.get(input.videoId);
  const version = input.version === undefined ? store.latestReady(input.videoId) : store.version(input.videoId, input.version);
  if (!video || !version) return refused("not_found", "No encuentro ese video.");
  if (version.status !== "ready") return refused("not_found", "El video todavía no está listo: esperá el aviso en el chat.");
  const dedupeKey = createHash("sha256").update(JSON.stringify([input.videoId, version.version, input.channel, input.to, input.text ?? ""])).digest("hex");
  const previous = store.findDelivery(dedupeKey);
  if (previous) return { ok: true, deliveryId: previous.id, file: previous.file, status: previous.status === "sent" ? "sent" : "queued", repeated: true };

  const delivery = deliveryFor(version, input.channel);
  const base = services.filesBaseUrl?.replace(/\/+$/, "");
  const links: string[] = [];
  if (video.pageSlug && base) links.push(`Versión interactiva: ${base}/${video.pageSlug}`);
  if ((delivery.file === "link" || input.channel === "email") && version.files.full && base && services.fileLinks) {
    links.push(`Ver o bajar el video: ${base}/d/${services.fileLinks.create(version.files.full.attachmentId, now).token}`);
  }
  if (delivery.file === "link" && links.length === 0) return refused("disabled", "El video no entra en ese canal y los links públicos no están configurados.");
  const text = [input.text, ...links].filter(Boolean).join("\n\n");
  const record = { videoId: input.videoId, version: version.version, channel: input.channel, recipient: input.to, file: delivery.file, dedupeKey } as const;
  const matchesRequest = video.send?.channel === input.channel && video.send.to === input.to;

  if (input.channel === "whatsapp") {
    if (!bridgeConnected(services.db, now)) return refused("not_connected", "WhatsApp no está conectado ahora: el video no se envió.", true);
    const id = randomUUID();
    new WhatsAppOutbox(services.db).enqueue({ id, chatJid: input.to, text, ...(delivery.file === "link" ? {} : { attachmentId: delivery.attachmentId }) }, now);
    const saved = store.addDelivery({ ...record, status: "queued", providerId: id }, now);
    if (matchesRequest) store.setSendStatus(input.videoId, "queued", now);
    return { ok: true, deliveryId: saved.id, file: delivery.file, status: "queued", repeated: false };
  }

  const gmail = services.gmail;
  if (!gmail) return refused("disabled", "Gmail no está configurado en el servidor.");
  const attach = delivery.file === "link" ? version.files.thumbnail : delivery.attachmentId;
  const stored = attach ? services.attachments?.read(attach) : undefined;
  try {
    const sent = await gmail.send(input.account ?? "personal", {
      to: [input.to],
      subject: input.subject ?? version.brief.title,
      body: text || version.brief.title,
      files: stored ? [{ name: stored.attachment.name, mediaType: stored.attachment.mediaType, data: stored.data }] : [],
    });
    const saved = store.addDelivery({ ...record, status: "sent", providerId: sent.id }, now);
    if (matchesRequest) store.setSendStatus(input.videoId, "sent", now);
    return { ok: true, deliveryId: saved.id, file: delivery.file, status: "sent", repeated: false };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "No pude mandar el mail.";
    if (matchesRequest) store.setSendStatus(input.videoId, "failed", now, message);
    return refused("upstream_error", message, true);
  }
}
