import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

const WAKE_VALID_MS = 2 * 60_000;

/** Cipher context of a media locator, so it cannot be swapped with another encrypted value. */
export const MEDIA_LOCATOR_CONTEXT = "wa-media-locator";

export type WaSource = "baileys" | "import";
/** How a new device is linked: a code sent to the owner's number, or a QR scanned from the phone. */
export type LinkMode = "code" | "qr";
export type WaSyncStatus = "disabled" | "pairing" | "connected" | "disconnected" | "logged_out" | "error" | "imported";

export interface NewWaMessage {
  id: string;
  chatJid: string;
  senderJid: string | null;
  senderName: string | null;
  fromMe: boolean;
  tsUtc: string;
  text: string;
  kind: "text" | "media" | "system";
  edited?: boolean;
  deleted?: boolean;
  source: WaSource;
  importBatchId?: string;
  /** Where to fetch the file of a media message; kept so it can be downloaded later, on request. */
  media?: WaMediaInfo;
}

export interface WaMediaInfo {
  kind: "image" | "video" | "audio" | "document" | "sticker";
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  seconds: number | null;
  voiceNote: boolean;
  /** Decryption key and CDN path; stored encrypted. */
  locator: { mediaKey: string; directPath: string | null; url: string | null };
}

export interface WaChatInfo {
  jid: string;
  name: string | null;
  isGroup: boolean;
}

export interface InsertOutcome {
  inserted: number;
  duplicates: number;
}

/** Write side of the WhatsApp tables, shared by the export importer and the Baileys bridge. */
export class WhatsAppStore {
  constructor(
    private readonly db: Db,
    /** Encrypts media locators; without it media messages are stored without a way to download them. */
    private readonly cipher?: TokenCipher,
  ) {}

  /** Remembers that a hidden WhatsApp id (…@lid) is this phone number, so one person is one person in every chat. */
  rememberLid(lid: string, jid: string, now: Date): void {
    if (!lid.endsWith("@lid") || !jid.endsWith("@s.whatsapp.net")) return;
    this.db
      .prepare("INSERT INTO wa_lid_map (lid, jid, updated_at) VALUES (?, ?, ?) ON CONFLICT (lid) DO UPDATE SET jid = excluded.jid, updated_at = excluded.updated_at")
      .run(lid, jid, now.toISOString());
  }

  upsertChat(chat: WaChatInfo, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (jid) DO UPDATE SET name = COALESCE(excluded.name, wa_chats.name), is_group = excluded.is_group, updated_at = excluded.updated_at`,
      )
      .run(chat.jid, chat.name, chat.isGroup ? 1 : 0, now.toISOString());
  }

  /** Inserts messages in one transaction; a message whose (chat_jid, id) already exists is left untouched. */
  insertMessages(messages: NewWaMessage[], now: Date): InsertOutcome {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO wa_messages
         (id, chat_jid, sender_jid, sender_name, from_me, ts_utc, text, kind, edited, deleted, source, import_batch_id, inserted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const media = this.db.prepare(
      `INSERT OR IGNORE INTO wa_media (chat_jid, message_id, kind, mimetype, file_name, size, seconds, voice_note, locator_enc, inserted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      let inserted = 0;
      for (const message of messages) {
        if (message.media && this.cipher) {
          const { kind, mimetype, fileName, size, seconds, voiceNote, locator } = message.media;
          const sealed = this.cipher.encrypt(JSON.stringify(locator), MEDIA_LOCATOR_CONTEXT);
          media.run(message.chatJid, message.id, kind, mimetype, fileName, size, seconds, voiceNote ? 1 : 0, sealed, now.toISOString());
        }
        const result = insert.run(
          message.id,
          message.chatJid,
          message.senderJid,
          message.senderName,
          message.fromMe ? 1 : 0,
          message.tsUtc,
          message.text,
          message.kind,
          message.edited ? 1 : 0,
          message.deleted ? 1 : 0,
          message.source,
          message.importBatchId ?? null,
          now.toISOString(),
        );
        inserted += result.changes;
      }
      return inserted;
    });
    const inserted = run.immediate();
    return { inserted, duplicates: messages.length - inserted };
  }

  applyEdit(chatJid: string, id: string, text: string): boolean {
    return this.db.prepare("UPDATE wa_messages SET text = ?, edited = 1 WHERE chat_jid = ? AND id = ? AND deleted = 0").run(text, chatJid, id).changes > 0;
  }

  markDeleted(chatJid: string, id: string): boolean {
    return this.db.prepare("UPDATE wa_messages SET text = '', deleted = 1 WHERE chat_jid = ? AND id = ?").run(chatJid, id).changes > 0;
  }

  /** Recomputes coverage for a source from the stored messages and records its status. */
  refreshSyncState(source: WaSource, status: WaSyncStatus, now: Date, detail: string | null = null): void {
    const totals = this.db
      .prepare("SELECT MIN(ts_utc) AS earliest, MAX(ts_utc) AS latest, COUNT(*) AS total FROM wa_messages WHERE source = ?")
      .get(source) as { earliest: string | null; latest: string | null; total: number };
    this.db
      .prepare(
        `INSERT INTO wa_sync_state (source, status, earliest_utc, latest_utc, message_count, last_event_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET status = excluded.status, earliest_utc = excluded.earliest_utc,
           latest_utc = excluded.latest_utc, message_count = excluded.message_count, last_event_at = excluded.last_event_at, detail = excluded.detail`,
      )
      .run(source, status, totals.earliest, totals.latest, totals.total, now.toISOString(), detail);
  }

  /** Asks the stopped bridge to connect again: with a pairing code sent to the owner's number, or with a QR when the owner asked for one in the chat. Honored for two minutes. */
  requestWake(now: Date, mode: LinkMode = "code"): void {
    const value = mode === "qr" ? now.toISOString() + "|qr" : now.toISOString();
    this.db.prepare("UPDATE wa_sync_state SET wake_requested_at = ? WHERE source = 'baileys'").run(value);
  }

  /** How the owner asked the bridge to connect in the last two minutes, if they did. The request is used up. */
  takeWake(now: Date): LinkMode | undefined {
    const row = this.db.prepare("SELECT wake_requested_at AS at FROM wa_sync_state WHERE source = 'baileys'").get() as { at: string | null } | undefined;
    if (!row?.at) return undefined;
    this.db.prepare("UPDATE wa_sync_state SET wake_requested_at = NULL WHERE source = 'baileys'").run();
    const [at = "", mode] = row.at.split("|");
    if (now.getTime() - Date.parse(at) > WAKE_VALID_MS) return undefined;
    return mode === "qr" ? "qr" : "code";
  }

  /** Records a status change without touching coverage columns (used by the bridge on every connection event). */
  setStatus(source: WaSource, status: WaSyncStatus, now: Date, detail: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO wa_sync_state (source, status, message_count, last_event_at, detail) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (source) DO UPDATE SET status = excluded.status, last_event_at = excluded.last_event_at, detail = excluded.detail`,
      )
      .run(source, status, now.toISOString(), detail);
  }
}
