import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../../db/database.js";
import { parseExport, type DateOrder, type ParsedMessage } from "./export-parser.js";
import { WhatsAppStore, type InsertOutcome, type NewWaMessage } from "./message-store.js";

export interface ImportOptions {
  text: string;
  chatName: string;
  timezone: string;
  /** Sender name the exporting phone shows for the owner's own messages. */
  me?: string;
  isGroup?: boolean;
  dateOrder?: DateOrder;
  now?: Date;
}

export interface ImportSummary extends InsertOutcome {
  chatJid: string;
  parsed: number;
  unparsedLines: number;
  dateOrder: DateOrder;
  isGroup: boolean;
  earliest: string | null;
  latest: string | null;
}

const normalizeName = (name: string) => name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** Imported chats have no JID; they get a stable synthetic one derived from the chat name. */
export function importChatJid(chatName: string): string {
  const slug = normalizeName(chatName).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `import:${slug || "chat"}`;
}

function withIds(chatJid: string, messages: ParsedMessage[]): { id: string; message: ParsedMessage }[] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const identity = JSON.stringify([chatJid, message.tsUtc, message.sender, message.text, message.kind]);
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    return { id: createHash("sha256").update(`${identity}#${ordinal}`).digest("hex").slice(0, 32), message };
  });
}

/**
 * Imports one exported chat. Ids are a hash of chat, time, sender, text and the ordinal of identical
 * lines, so importing the same (or a longer, overlapping) export again adds only the new messages.
 */
export function importExport(db: Db, options: ImportOptions): ImportSummary {
  const now = options.now ?? new Date();
  const parsed = parseExport(options.text, { timezone: options.timezone, dateOrder: options.dateOrder });
  const chatJid = importChatJid(options.chatName);
  const senders = new Set(parsed.messages.flatMap((message) => (message.sender ? [message.sender] : [])));
  const isGroup = options.isGroup ?? senders.size > 2;
  const me = options.me ? normalizeName(options.me) : undefined;
  const batchId = randomUUID();

  const rows: NewWaMessage[] = withIds(chatJid, parsed.messages).map(({ id, message }) => ({
    id,
    chatJid,
    senderJid: null,
    senderName: message.sender,
    fromMe: me !== undefined && message.sender !== null && normalizeName(message.sender) === me,
    tsUtc: message.tsUtc,
    text: message.text,
    kind: message.kind,
    edited: message.edited,
    deleted: message.deleted,
    source: "import",
    importBatchId: batchId,
  }));

  const store = new WhatsAppStore(db);
  store.upsertChat({ jid: chatJid, name: options.chatName, isGroup }, now);
  const outcome = store.insertMessages(rows, now);
  store.refreshSyncState("import", "imported", now, `Último import: ${options.chatName}`);

  const times = parsed.messages.map((message) => message.tsUtc).sort();
  return {
    ...outcome,
    chatJid,
    parsed: parsed.messages.length,
    unparsedLines: parsed.unparsedLines,
    dateOrder: parsed.dateOrder,
    isGroup,
    earliest: times[0] ?? null,
    latest: times.at(-1) ?? null,
  };
}
