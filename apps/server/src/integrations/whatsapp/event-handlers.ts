import type { BaileysEventMap, Chat, Contact, GroupMetadata, WAMessage } from "baileys";
import { WAMessageStubType } from "baileys";
import { chatJidOf, describeContent, isIgnoredJid, toNewMessage } from "./message-mapper.js";
import type { InsertOutcome, NewWaMessage, WhatsAppStore } from "./message-store.js";

const BATCH_SIZE = 500;

type MessageUpdate = BaileysEventMap["messages.update"][number];
type MessagesDelete = BaileysEventMap["messages.delete"];

/**
 * Turns Baileys events into rows. Messages are deduplicated by (chat_jid, id), so history syncs and
 * reconnections can replay the same message safely. Nothing here ever sends anything to WhatsApp.
 */
export class WhatsAppEventHandlers {
  constructor(
    private readonly store: WhatsAppStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  messagesUpsert(messages: WAMessage[]): InsertOutcome {
    const rows = messages.map(toNewMessage).filter((row): row is NewWaMessage => row !== undefined);
    this.touchChats(rows);
    return this.insertInBatches(rows);
  }

  messagesUpdate(updates: MessageUpdate[]): void {
    for (const { key, update } of updates) {
      const chatJid = chatJidOf(key);
      if (!chatJid || !key.id) continue;
      if (update.messageStubType === WAMessageStubType.REVOKE) {
        this.store.markDeleted(chatJid, key.id);
        continue;
      }
      const edited = describeContent(update.message?.editedMessage?.message);
      if (edited) this.store.applyEdit(chatJid, key.id, edited.text);
    }
  }

  /** Honors per-message deletions; wiping a whole chat on the phone does not erase the archive. */
  messagesDelete(event: MessagesDelete): void {
    if (!("keys" in event)) return;
    for (const key of event.keys) {
      const chatJid = chatJidOf(key);
      if (chatJid && key.id) this.store.markDeleted(chatJid, key.id);
    }
  }

  historySet(event: BaileysEventMap["messaging-history.set"]): InsertOutcome {
    this.chatNames(event.chats);
    this.contactNames(event.contacts);
    return this.messagesUpsert(event.messages);
  }

  chatNames(chats: Chat[]): void {
    for (const chat of chats) {
      if (!chat.id || isIgnoredJid(chat.id) || !chat.name) continue;
      this.store.upsertChat({ jid: chat.id, name: chat.name, isGroup: chat.id.endsWith("@g.us") }, this.now());
    }
  }

  contactNames(contacts: Contact[]): void {
    for (const contact of contacts) {
      const jid = contact.phoneNumber ?? contact.id;
      const name = contact.name ?? contact.notify;
      if (!jid || isIgnoredJid(jid) || jid.endsWith("@g.us") || !name) continue;
      this.store.upsertChat({ jid, name, isGroup: false }, this.now());
    }
  }

  groupSubjects(groups: Partial<GroupMetadata>[]): void {
    for (const group of groups) {
      if (group.id && group.subject) this.store.upsertChat({ jid: group.id, name: group.subject, isGroup: true }, this.now());
    }
  }

  private touchChats(rows: NewWaMessage[]): void {
    for (const chatJid of new Set(rows.map((row) => row.chatJid))) {
      this.store.upsertChat({ jid: chatJid, name: null, isGroup: chatJid.endsWith("@g.us") }, this.now());
    }
  }

  private insertInBatches(rows: NewWaMessage[]): InsertOutcome {
    const total: InsertOutcome = { inserted: 0, duplicates: 0 };
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const outcome = this.store.insertMessages(rows.slice(start, start + BATCH_SIZE), this.now());
      total.inserted += outcome.inserted;
      total.duplicates += outcome.duplicates;
    }
    return total;
  }
}
