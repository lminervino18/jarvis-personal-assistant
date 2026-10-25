import { isLidUser, jidNormalizedUser, normalizeMessageContent, toNumber, type WAMessage, type WAMessageKey, type proto } from "baileys";
import type { NewWaMessage } from "./message-store.js";

const IGNORED_SUFFIXES = ["@broadcast", "@newsletter"];
const MEDIA_FIELDS = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "ptvMessage"] as const;

export interface MessageContent {
  kind: "text" | "media";
  text: string;
}

export function isIgnoredJid(jid: string | null | undefined): boolean {
  return !jid || IGNORED_SUFFIXES.some((suffix) => jid.endsWith(suffix));
}

/** The phone-number form of the chat id when WhatsApp gives both, so one chat never splits in two. */
export function chatJidOf(key: WAMessageKey): string | undefined {
  const jid = key.remoteJid && isLidUser(key.remoteJid) && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid;
  return jid ? jidNormalizedUser(jid) : undefined;
}

export function describeContent(message: proto.IMessage | null | undefined): MessageContent | undefined {
  const content = normalizeMessageContent(message);
  if (!content) return undefined;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? undefined;
  if (text) return { kind: "text", text };
  for (const field of MEDIA_FIELDS) {
    const media = content[field];
    if (media) return { kind: "media", text: (media as { caption?: string | null }).caption ?? "" };
  }
  return undefined;
}

function senderOf(key: WAMessageKey, chatJid: string): string | null {
  if (key.fromMe) return null;
  const participant = key.participantAlt ?? key.participant;
  return participant ? jidNormalizedUser(participant) : chatJid;
}

/** Maps a Baileys message to a stored row, or undefined for statuses, reactions, protocol messages and the like. */
export function toNewMessage(message: WAMessage): NewWaMessage | undefined {
  const chatJid = chatJidOf(message.key);
  const id = message.key.id;
  const content = describeContent(message.message);
  const seconds = toNumber(message.messageTimestamp);
  if (!id || !chatJid || isIgnoredJid(chatJid) || !content || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return {
    id,
    chatJid,
    senderJid: senderOf(message.key, chatJid),
    senderName: message.key.fromMe ? null : (message.pushName ?? null),
    fromMe: message.key.fromMe === true,
    tsUtc: new Date(seconds * 1000).toISOString(),
    text: content.text,
    kind: content.kind,
    source: "baileys",
  };
}
