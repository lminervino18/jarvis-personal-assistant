import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { JARVIS_MARK, mentionsJarvis, saysAbajo, WhatsAppWatcher, type MentionRequest } from "./watcher.js";

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
    expect(requests[0]).toMatchObject({ chatName: "Marti", isGroup: false, mention: { who: "Marti", text: "@jarvis quién ganó el mundial 86" } });
    expect(requests[0]?.lines.map((line) => line.text)).toEqual(["che una pregunta", "@jarvis quién ganó el mundial 86"]);
  });

  it("answers at most a few times an hour per chat, so nobody burns the owner's quota", async () => {
    let clock = now;
    const env = setup(async () => "Otra vez vos.");
    const watcher = new WhatsAppWatcher({ db: env.db, ownerName: "Loren", repliesPerHour: 3, now: () => clock, reply: async () => "Otra vez vos." });
    await watcher.tick();
    for (const minutes of [0, 10, 20, 30, 61]) {
      clock = new Date(now.getTime() + minutes * 60_000);
      env.message(MARTI, `@jarvis pregunta del minuto ${minutes}`, { at: clock });
      await watcher.tick();
    }
    expect(env.sent()).toHaveLength(4);
    expect(env.db.prepare("SELECT message_id FROM wa_auto_replies ORDER BY created_at").all()).toHaveLength(4);
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
