import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import type { Narration } from "../videos/narrator.js";
import { VOICE_NOTE_TYPE, VoiceNoteMaker } from "../voice/voice-note.js";
import { toolsByName } from "./index.js";
import { decidePendingAction, runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

const NOW = new Date("2026-11-23T20:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = openMigratedDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-note-"));
  dirs.push(dir);
  const at = NOW.toISOString();
  db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', ?, ?)").run(at, at);
  db.prepare("INSERT INTO wa_sync_state (source, status, last_event_at) VALUES ('baileys', 'connected', ?)").run(at);
  db.prepare("INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES ('5490000000002@s.whatsapp.net', 'Carme', 0, ?)").run(at);
  const spoken: string[] = [];
  const cards: Card[] = [];
  const ctx: ToolContext = {
    services: {
      db,
      timezone: "America/Argentina/Buenos_Aires",
      backupRetentionDays: 30,
      statusSources: [],
      attachments: new AttachmentStore(db, dir),
      ownerName: "Loren",
      voiceNotes: {
        make: async (text) => {
          spoken.push(text);
          return { data: Buffer.from("OggS-opus"), seconds: 6 };
        },
      },
    },
    conversationId: "c1",
    turnId: "t1",
    now: () => NOW,
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  const call = (input: object) => runTool(ctx, toolsByName.get("whatsapp_voice_note") as AnyToolDefinition, input);
  return { db, ctx, call, spoken, cards };
}

describe("whatsapp voice notes", () => {
  it("sends the voice note right away when the owner asks, alone, as a fresh recording", async () => {
    const { db, call, spoken, cards } = setup();
    const text = "Hola Carme, soy Jarvis, el asistente de Loren. Me dijo que te avise que llega a las nueve.";
    expect(await call({ chatId: "Carme", text })).toMatchObject({ ok: true, items: [{ chat: "Carme", seconds: 6, status: "queued" }] });
    expect(cards).toEqual([]);
    expect(spoken).toEqual([text]);
    const row = db.prepare("SELECT o.chat_jid, o.text, a.name, a.media_type FROM wa_outbox o JOIN attachments a ON a.id = o.attachment_id").get();
    expect(row).toEqual({ chat_jid: "5490000000002@s.whatsapp.net", text: "", name: "nota-de-voz.ogg", media_type: VOICE_NOTE_TYPE });
  });

  it("after reading third-party content, records nothing until the owner confirms", async () => {
    const { db, ctx, call, spoken, cards } = setup();
    ctx.security.tainted = true;
    const text = "Hola Carme, soy Jarvis, el asistente de Loren. Me dijo que te avise que llega a las nueve.";
    const pending = await call({ chatId: "Carme", text });
    expect(pending).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    expect(cards[0]).toMatchObject({ kind: "confirm", title: "Enviar nota de voz", summary: "Para Carme", details: [{ label: "Dice", value: text }, { label: "Duración" }] });
    expect(spoken).toEqual([]);

    const sent = await decidePendingAction(ctx, toolsByName, (pending as { error: { actionId: string } }).error.actionId, "confirm");
    expect(sent).toMatchObject({ status: "executed", result: { ok: true } });
    expect(spoken).toEqual([text]);
    const row = db.prepare("SELECT o.chat_jid, o.text, a.name, a.media_type FROM wa_outbox o JOIN attachments a ON a.id = o.attachment_id").get();
    expect(row).toEqual({ chat_jid: "5490000000002@s.whatsapp.net", text: "", name: "nota-de-voz.ogg", media_type: VOICE_NOTE_TYPE });
  });

  it("introduces itself only the first time it talks to a chat", async () => {
    const { call, cards } = setup();
    const first = await call({ chatId: "Carme", text: "Hola Carme, llego a las nueve." });
    expect(first).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("Es la primera vez que le hablás a Carme") } });
    expect(first).toMatchObject({ error: { message: expect.stringContaining("soy Jarvis, el asistente de Loren") } });
    expect(cards).toEqual([]);

    expect((await call({ chatId: "Carme", text: "Hola Carme, soy Jarvis, el asistente de Loren. Llega a las nueve." })).ok).toBe(true);
    const again = await call({ chatId: "Carme", text: "Hola Carme, soy Jarvis, el asistente de Loren. Se atrasa media hora." });
    expect(again).toMatchObject({ ok: false, error: { message: expect.stringContaining("Ya te presentaste antes con Carme") } });
    expect((await call({ chatId: "Carme", text: "Hola Carme, se atrasa media hora." })).ok).toBe(true);
  });

  it("says whether to greet: after hours of silence it greets, in an active chat it goes straight to the point", async () => {
    const { db, call } = setup();
    expect((await call({ chatId: "Carme", text: "Hola Carme, soy Jarvis, el asistente de Loren. Llega a las nueve." })).ok).toBe(true);
    const message = (minutesAgo: number) =>
      db
        .prepare("INSERT INTO wa_messages (id, chat_jid, from_me, ts_utc, text, source, inserted_at) VALUES (?, '5490000000002@s.whatsapp.net', 0, ?, 'dale', 'baileys', ?)")
        .run(`m${minutesAgo}`, new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), NOW.toISOString());
    message(300);
    expect(await call({ chatId: "Carme", text: "Hola Carme, soy Jarvis de nuevo, el asistente de Loren." })).toMatchObject({ error: { message: expect.stringContaining("saludá («Hola Carme»)") } });
    message(5);
    expect(await call({ chatId: "Carme", text: "Soy Jarvis, el asistente de Loren: ya sale." })).toMatchObject({ error: { message: expect.stringContaining("andá directo al mensaje") } });
  });

  it("encodes the narration as mono Opus at 48 kHz, the format of WhatsApp voice notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-note-"));
    dirs.push(dir);
    const narration: Narration = { file: "n.wav", path: join(dir, "n.wav"), durationMs: 5400, words: [], characters: 40, cached: false };
    const calls: string[][] = [];
    const maker = new VoiceNoteMaker({ narrate: async () => narration }, async (command, args) => {
      calls.push([command, ...args]);
      writeFileSync(args.at(-1) as string, "OggS");
      return { stdout: "", stderr: "" };
    });
    const note = await maker.make("Hola, soy Jarvis.");
    expect(note).toEqual({ data: Buffer.from("OggS"), seconds: 5 });
    expect(calls[0]).toEqual(expect.arrayContaining(["ffmpeg", narration.path, "-ac", "1", "-ar", "48000", "-c:a", "libopus"]));
  });
});
