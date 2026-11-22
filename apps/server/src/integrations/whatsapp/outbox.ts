import type { Db } from "../../db/database.js";

export interface OutboxMessage {
  id: string;
  chatJid: string;
  text: string;
  /** A chat attachment sent as a photo or document, with `text` as its caption. */
  attachmentId?: string;
}

/** Outbox destination meaning the owner's own chat ("message yourself"); the bridge resolves it to the paired number. */
export const OWN_CHAT = "me";

/**
 * Messages the owner confirmed for sending. Delivery is at most once: a message is claimed
 * (`sending`) before the socket call, and a claim interrupted by a crash becomes `unknown`
 * instead of being retried, because WhatsApp may already have delivered it.
 */
export class WhatsAppOutbox {
  constructor(private readonly db: Db) {}

  enqueue(message: OutboxMessage, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO wa_outbox (id, chat_jid, text, attachment_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(message.id, message.chatJid, message.text, message.attachmentId ?? null, at, at);
  }

  claimNext(now: Date): OutboxMessage | undefined {
    return this.db
      .transaction(() => {
        const row = this.db.prepare("SELECT id, chat_jid, text, attachment_id FROM wa_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 1").get() as
          | { id: string; chat_jid: string; text: string; attachment_id: string | null }
          | undefined;
        if (!row) return undefined;
        this.db.prepare("UPDATE wa_outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'").run(now.toISOString(), row.id);
        return { id: row.id, chatJid: row.chat_jid, text: row.text, ...(row.attachment_id ? { attachmentId: row.attachment_id } : {}) };
      })
      .immediate();
  }

  markSent(id: string, messageId: string | undefined, now: Date): void {
    this.db.prepare("UPDATE wa_outbox SET status = 'sent', message_id = ?, updated_at = ? WHERE id = ?").run(messageId ?? null, now.toISOString(), id);
  }

  markFailed(id: string, error: string, now: Date): void {
    this.db.prepare("UPDATE wa_outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 200), now.toISOString(), id);
  }

  /** Claims left by a previous process: delivery is uncertain, so they are never retried. */
  abandonInterrupted(now: Date): number {
    return this.db.prepare("UPDATE wa_outbox SET status = 'unknown', updated_at = ? WHERE status = 'sending'").run(now.toISOString()).changes;
  }

  status(id: string): { status: string; error: string | null } | undefined {
    return this.db.prepare("SELECT status, error FROM wa_outbox WHERE id = ?").get(id) as { status: string; error: string | null } | undefined;
  }
}
