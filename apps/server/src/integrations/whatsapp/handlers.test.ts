import type { BaileysEventMap, WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { WhatsAppEventHandlers } from "./event-handlers.js";
import { WhatsAppReader } from "./message-reader.js";
import { WhatsAppStore } from "./message-store.js";
import { TIMEZONE, loadBaileysFixture } from "./test-support.js";

const now = new Date("2026-10-26T12:00:00Z");
const fixture = loadBaileysFixture<{
  history: BaileysEventMap["messaging-history.set"];
  live: WAMessage[];
  edit: BaileysEventMap["messages.update"][number];
  revoke: BaileysEventMap["messages.update"][number];
  deleteKeys: BaileysEventMap["messages.delete"] extends infer D ? (D extends { keys: infer K } ? K : never) : never;
}>();

function setup() {
  const db = openMigratedDatabase(":memory:");
  const handlers = new WhatsAppEventHandlers(new WhatsAppStore(db), () => now);
  const reader = new WhatsAppReader(db, TIMEZONE);
  const count = () => (db.prepare("SELECT count(*) AS n FROM wa_messages").get() as { n: number }).n;
  return { db, handlers, reader, count };
}

describe("history sync", () => {
  it("stores text, captions and media; ignores statuses and reactions", () => {
    const { db, handlers } = setup();
    expect(handlers.historySet(fixture.history)).toEqual({ inserted: 6, duplicates: 0 });

    const rows = db.prepare("SELECT id, chat_jid, sender_jid, sender_name, from_me, kind, text, source FROM wa_messages ORDER BY ts_utc").all();
    expect(rows).toEqual([
      expect.objectContaining({ id: "H1", chat_jid: "5490000000001@s.whatsapp.net", sender_jid: "5490000000001@s.whatsapp.net", sender_name: "Ana Prueba", from_me: 0, source: "baileys" }),
      expect.objectContaining({ id: "H2", from_me: 1, sender_jid: null, sender_name: null }),
      expect.objectContaining({ id: "H3", chat_jid: "120363000000000001@g.us", sender_jid: "5490000000002@s.whatsapp.net", sender_name: "Beto Ejemplo" }),
      expect.objectContaining({ id: "H4", kind: "media", text: "La receta del postre" }),
      expect.objectContaining({ id: "H5", kind: "media", text: "" }),
      expect.objectContaining({ id: "E1", kind: "text", text: "Mensaje efímero de prueba" }),
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM wa_messages WHERE chat_jid = 'status@broadcast'").get()).toEqual({ n: 0 });
  });

  it("names chats and groups from the sync", () => {
    const { db, handlers } = setup();
    handlers.historySet(fixture.history);
    const chats = db.prepare("SELECT jid, name, is_group FROM wa_chats ORDER BY jid").all();
    expect(chats).toEqual([
      { jid: "120363000000000001@g.us", name: "Cena de prueba", is_group: 1 },
      { jid: "5490000000001@s.whatsapp.net", name: "Ana Prueba", is_group: 0 },
      { jid: "5490000000002@s.whatsapp.net", name: "Beto Ejemplo", is_group: 0 },
    ]);
  });

  it("makes synced messages searchable with coverage for the baileys source", () => {
    const { handlers, reader } = setup();
    handlers.historySet(fixture.history);
    const page = reader.search({ query: "postre receta", limit: 5 });
    expect(page.items.map((item) => item.messageId)).toEqual(["H4"]);
    const coverage = reader.coverage();
    expect(coverage.sources).toEqual([expect.objectContaining({ source: "baileys", messages: 6 })]);
  });
});

describe("live events", () => {
  it("dedupes replays by chat and message id", () => {
    const { handlers, count } = setup();
    handlers.historySet(fixture.history);
    const after = handlers.messagesUpsert(fixture.live);
    expect(after).toEqual({ inserted: 2, duplicates: 1 });
    expect(handlers.messagesUpsert(fixture.live)).toEqual({ inserted: 0, duplicates: 3 });
    expect(handlers.historySet(fixture.history)).toEqual({ inserted: 0, duplicates: 6 });
    expect(count()).toBe(8);
  });

  it("keeps one chat when WhatsApp gives both the LID and the phone-number form", () => {
    const { db, handlers } = setup();
    handlers.messagesUpsert(fixture.live);
    expect(db.prepare("SELECT chat_jid, sender_name FROM wa_messages WHERE id = 'LID1'").get()).toEqual({
      chat_jid: "5490000000009@s.whatsapp.net",
      sender_name: "Carla Ficticia",
    });
  });

  it("applies edits and keeps the search index in step", () => {
    const { handlers, reader, db } = setup();
    handlers.messagesUpsert(fixture.live);
    expect(reader.search({ query: "tokens", limit: 5 }).items).toHaveLength(1);

    handlers.messagesUpdate([fixture.edit]);
    expect(db.prepare("SELECT text, edited FROM wa_messages WHERE id = 'L1'").get()).toEqual({ text: "Texto corregido en la edición", edited: 1 });
    expect(reader.search({ query: "tokens", limit: 5 }).items).toEqual([]);
    expect(reader.search({ query: "corregido", limit: 5 }).items[0]).toMatchObject({ messageId: "L1", edited: true });
  });

  it("marks revoked and deleted messages, emptying their text and index entries", () => {
    const { handlers, reader, db } = setup();
    handlers.historySet(fixture.history);
    handlers.messagesUpdate([fixture.revoke]);
    handlers.messagesDelete({ keys: fixture.deleteKeys });
    expect(db.prepare("SELECT id, text, deleted FROM wa_messages WHERE deleted = 1 ORDER BY id").all()).toEqual([
      { id: "H2", text: "", deleted: 1 },
      { id: "H3", text: "", deleted: 1 },
    ]);
    expect(reader.search({ query: "sábado", limit: 5 }).items).toEqual([]);
  });

  it("does not erase the archive when a whole chat is cleared on the phone", () => {
    const { handlers, count } = setup();
    handlers.historySet(fixture.history);
    handlers.messagesDelete({ jid: "5490000000001@s.whatsapp.net", all: true });
    expect(count()).toBe(6);
  });

  it("ignores updates for messages it never saw", () => {
    const { handlers, count } = setup();
    handlers.messagesUpdate([fixture.edit, fixture.revoke]);
    handlers.messagesDelete({ keys: fixture.deleteKeys });
    expect(count()).toBe(0);
  });
});
