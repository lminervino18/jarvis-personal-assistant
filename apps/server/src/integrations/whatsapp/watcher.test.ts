import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../../attachments/attachment-store.js";
import { openMigratedDatabase } from "../../db/database.js";
import { deliveryOf, JARVIS_MARK, mentionsJarvis, noTokensText, ownerMentionPrompt, saysAbajo, WhatsAppWatcher, type MentionRequest } from "./watcher.js";

const MARTI = "5491100000001@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const BIG_GROUP = "120363000000000002@g.us";

describe("«abajo» in any spelling", () => {
  it("catches the ways people say they are downstairs", () => {
    for (const text of ["abajo", "ABAJO", "Abajoo", "abajooooo!!", "abajao", "abjo", "abaj", "Estoy abajo", "ya estoy abajo 🙌", "aca abajo", "Bajá, estoy abajo", "ya llegué, te espero abajo así vamos juntos al cine"]) {
      expect(saysAbajo(text), text).toBe(true);
    }
  });

  it("ignores «abajo» in a longer message about something else, and words that are not it", () => {
    for (const text of ["mirá el link que te mandé más abajo en el chat de ayer", "baja", "bajá", "abajito", "nos vemos abajo del puente el sábado a la noche si podés"]) {
      expect(saysAbajo(text), text).toBe(false);
    }
  });

  it("knows a call to @jarvis from a mention of someone else", () => {
    expect(mentionsJarvis("@jarvis quién ganó el mundial 86")).toBe(true);
    expect(mentionsJarvis("che @Jarvis, opiná")).toBe(true);
    expect(mentionsJarvis("jarvis decí algo")).toBe(false);
    expect(mentionsJarvis("mail a hola@jarvis.com")).toBe(false);
    expect(mentionsJarvis("@jarvisito")).toBe(false);
  });
});

describe("watching WhatsApp", () => {
  const now = new Date("2026-11-26T15:00:00Z");

  function setup(reply?: (request: MentionRequest) => Promise<string | undefined>) {
    const db = openMigratedDatabase(":memory:");
    let id = 0;
    const message = (chat: string, text: string, options: { fromMe?: boolean; sender?: string; senderName?: string; at?: Date } = {}) =>
      db
        .prepare("INSERT INTO wa_messages (id, chat_jid, sender_jid, sender_name, from_me, ts_utc, text, source, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'baileys', ?)")
        .run(`m${++id}`, chat, options.sender ?? null, options.senderName ?? null, options.fromMe ? 1 : 0, (options.at ?? now).toISOString(), text, now.toISOString());
    db.prepare("INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES (?, 'Marti', 0, ?), (?, 'Los pibes', 1, ?), (?, 'Consorcio', 1, ?)").run(
      MARTI,
      now.toISOString(),
      GROUP,
      now.toISOString(),
      BIG_GROUP,
      now.toISOString(),
    );
    message("old@s.whatsapp.net", "abajo", { at: new Date(now.getTime() - 3_600_000) });
    const watcher = new WhatsAppWatcher({ db, ownerName: "Loren", now: () => now, ...(reply ? { reply } : {}) });
    const pushes = () => (db.prepare("SELECT payload_json AS p FROM outbox WHERE kind = 'push' ORDER BY id").all() as { p: string }[]).map((row) => (JSON.parse(row.p) as { body: string }).body);
    const sent = () => db.prepare("SELECT chat_jid AS chat, text FROM wa_outbox").all() as { chat: string; text: string }[];
    return { db, watcher, message, pushes, sent };
  }

  it("tells the owner who is downstairs, once, from private chats and the groups they write in", async () => {
    const env = setup();
    await env.watcher.tick();
    env.message(GROUP, "nos vemos en un rato", { fromMe: true, at: new Date(now.getTime() - 86_400_000) });
    env.message(MARTI, "ABAJOOO");
    env.message(MARTI, "abajo!!");
    env.message(GROUP, "ya estoy abajo", { sender: "5491100000002@s.whatsapp.net", senderName: "Gero" });
    env.message(BIG_GROUP, "abajo", { sender: "5491100000003@s.whatsapp.net", senderName: "Vecina" });
    env.message(MARTI, "abajo", { fromMe: true });
    env.message(MARTI, "abajo", { at: new Date(now.getTime() - 30 * 60_000) });
    await env.watcher.tick();
    expect(env.pushes().sort()).toEqual(["Gero está abajo (lo dijo en «Los pibes»).", "Marti está abajo."]);
  });

  it("starts from now the first time, so old messages never alert", async () => {
    const env = setup();
    await env.watcher.tick();
    expect(env.pushes()).toEqual([]);
  });

  it("answers @jarvis in the same chat with the chat's context, never itself, and within limits", async () => {
    const requests: MentionRequest[] = [];
    const env = setup(async (request) => {
      requests.push(request);
      return "Claro, porque googlear era demasiado esfuerzo. Fue Argentina, @jarvis lo confirma.";
    });
    await env.watcher.tick();
    env.message(MARTI, "che una pregunta");
    env.message(MARTI, "@jarvis quién ganó el mundial 86");
    env.message(MARTI, `${JARVIS_MARK} respuesta vieja de @jarvis`, { fromMe: true });
    env.message(MARTI, "@jarvis otra más", {});
    await env.watcher.tick();
    expect(env.sent()).toEqual([{ chat: MARTI, text: `${JARVIS_MARK} Claro, porque googlear era demasiado esfuerzo. Fue Argentina, Jarvis lo confirma.` }]);
    expect(requests).toHaveLength(1);
    const quote = (env.db.prepare("SELECT quote_json AS q FROM wa_outbox").get() as { q: string }).q;
    expect(JSON.parse(quote)).toEqual({ id: "m3", fromMe: false, text: "@jarvis quién ganó el mundial 86" });
    expect(requests[0]).toMatchObject({ chatName: "Marti", isGroup: false, mention: { who: "Marti", text: "@jarvis quién ganó el mundial 86" } });
    expect(requests[0]?.lines.map((line) => line.text)).toEqual(["che una pregunta", "@jarvis quién ganó el mundial 86"]);
  });

  it("answers each person at most five times every half hour, adding up their private chat and every group", async () => {
    let clock = now;
    const env = setup();
    const watcher = new WhatsAppWatcher({ db: env.db, ownerName: "Loren", now: () => clock, reply: async () => "Otra vez vos." });
    await watcher.tick();
    env.message(GROUP, "hola", { fromMe: true, at: new Date(now.getTime() - 86_400_000) });
    env.db.prepare("INSERT INTO wa_lid_map (lid, jid, updated_at) VALUES ('99887766@lid', ?, ?)").run(MARTI, now.toISOString());
    const ask = async (minutes: number, chat: string, options: { sender?: string; fromMe?: boolean } = {}) => {
      clock = new Date(now.getTime() + minutes * 60_000);
      env.message(chat, `@jarvis pregunta ${minutes}`, { at: clock, ...options });
      await watcher.tick();
    };
    await ask(0, MARTI);
    await ask(1, GROUP, { sender: "99887766@lid" });
    await ask(2, MARTI);
    await ask(3, GROUP, { sender: "99887766@lid" });
    await ask(4, MARTI);
    await ask(5, GROUP, { sender: "99887766@lid" });
    expect(env.sent()).toHaveLength(5);
    await ask(6, GROUP, { sender: "5491100000002@s.whatsapp.net" });
    await ask(7, GROUP, { fromMe: true });
    await ask(8, MARTI, { fromMe: true });
    expect(env.sent()).toHaveLength(8);
    await ask(31, MARTI);
    expect(env.sent()).toHaveLength(9);
  });

  it("answers with a voice note quoting the call, and with text when the voice is not available", async () => {
    const env = setup();
    const said: string[] = [];
    const attachments = new AttachmentStore(env.db, mkdtempSync(join(tmpdir(), "jarvis-watch-")));
    const voiced = new WhatsAppWatcher({ db: env.db, ownerName: "Loren", now: () => now, reply: async () => "Cuatro, genio.", attachments, speak: async (text) => (said.push(text), { data: Buffer.from("OggS") }) });
    await voiced.tick();
    env.message(MARTI, "@jarvis cuánto es 2+2");
    await voiced.tick();
    expect(said).toEqual(["Cuatro, genio."]);
    const row = env.db.prepare("SELECT text, attachment_id AS attachment, quote_json AS quote FROM wa_outbox").get() as { text: string; attachment: string; quote: string };
    expect(row.text).toBe("");
    expect(attachments.get(row.attachment)).toMatchObject({ name: "nota-de-voz.ogg", mediaType: "audio/ogg; codecs=opus" });
    expect(JSON.parse(row.quote)).toMatchObject({ text: "@jarvis cuánto es 2+2" });

    const silent = setup();
    const textOnly = new WhatsAppWatcher({ db: silent.db, ownerName: "Loren", now: () => now, reply: async () => "Cuatro.", attachments: new AttachmentStore(silent.db, mkdtempSync(join(tmpdir(), "jarvis-watch-"))), speak: async () => Promise.reject(new Error("no voice")) });
    await textOnly.tick();
    silent.message(MARTI, "@jarvis cuánto es 2+2");
    await textOnly.tick();
    expect(silent.sent()).toEqual([{ chat: MARTI, text: `${JARVIS_MARK} Cuatro.` }]);
  });

  it("sends banter as a voice note and links, figures or lists as text", () => {
    expect(deliveryOf("[audio] Cuatro, genio.")).toEqual({ mode: "voice", text: "Cuatro, genio." });
    expect(deliveryOf("[texto] Flor → Pavón: $13.495")).toEqual({ mode: "text", text: "Flor → Pavón: $13.495" });
    expect(deliveryOf("Tomá: https://youtu.be/x")).toMatchObject({ mode: "text" });
    expect(deliveryOf("Gero 12.179, Lucas 12.179, Fran 12.179, Stefa 11.667, Pavón 735 y Santi 13.495")).toMatchObject({ mode: "text" });
    expect(deliveryOf("Opciones:\n- una\n- otra")).toMatchObject({ mode: "text" });
    expect(deliveryOf("Obvio que sí, jefe.")).toMatchObject({ mode: "voice" });
  });

  it("runs the owner's own @jarvis as a full JARVIS turn and sends what it decides as text", async () => {
    const env = setup(async () => "nunca para el dueño");
    const asked: MentionRequest[] = [];
    const attachments = new AttachmentStore(env.db, mkdtempSync(join(tmpdir(), "jarvis-watch-")));
    const watcher = new WhatsAppWatcher({
      db: env.db,
      ownerName: "Loren",
      now: () => now,
      attachments,
      reply: async () => "nunca para el dueño",
      ownerTurn: async (request) => (asked.push(request), "[texto] Flor → Loren: $13.495\n\nAlias Loren: lminervino18"),
      speak: async () => ({ data: Buffer.from("OggS") }),
    });
    await watcher.tick();
    env.message(GROUP, "@jarvis hacé un tricount", { fromMe: true });
    await watcher.tick();
    expect(asked[0]).toMatchObject({ chatId: GROUP, chatName: "Los pibes", isGroup: true, mention: { fromOwner: true } });
    expect(env.sent()).toEqual([{ chat: GROUP, text: `${JARVIS_MARK} Flor → Loren: $13.495\n\nAlias Loren: lminervino18` }]);
    expect(ownerMentionPrompt(asked[0]!)).toContain("[audio] o [texto]");
  });

  it("answers with the same funny voice note when Claude has no quota left, made once", async () => {
    const env = setup();
    const said: string[] = [];
    const attachments = new AttachmentStore(env.db, mkdtempSync(join(tmpdir(), "jarvis-watch-")));
    let calls = 0;
    const watcher = new WhatsAppWatcher({
      db: env.db,
      ownerName: "Loren",
      now: () => now,
      attachments,
      reply: async () => (calls++, "no debería llamarse"),
      outOfQuota: async () => true,
      speak: async (text) => (said.push(text), { data: Buffer.from("OggS") }),
    });
    env.message(GROUP, "hola", { fromMe: true, at: new Date(now.getTime() - 3_600_000) });
    await watcher.tick();
    env.message(MARTI, "@jarvis estás?");
    env.message(GROUP, "@jarvis dale", { sender: "5491100000002@s.whatsapp.net", senderName: "Gero" });
    await watcher.tick();
    expect(calls).toBe(0);
    expect(said).toEqual([noTokensText("Loren")]);
    expect(noTokensText("Loren")).toContain("Houston, we have a problem");
    expect(env.db.prepare("SELECT COUNT(*) FROM wa_outbox WHERE attachment_id IS NOT NULL").pluck().get()).toBe(2);
  });

  it("stays quiet in groups the owner does not write in, and when the model gives nothing", async () => {
    const env = setup(async () => undefined);
    await env.watcher.tick();
    env.message(BIG_GROUP, "@jarvis hola", { sender: "x@s.whatsapp.net" });
    env.message(MARTI, "@jarvis hola");
    await env.watcher.tick();
    expect(env.sent()).toEqual([]);
  });
});
