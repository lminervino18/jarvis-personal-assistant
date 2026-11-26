import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { DownloadError, type MediaDownloader } from "../downloads/media-downloader.js";
import { MediaChoices } from "../downloads/media-choices.js";
import { MediaQueue } from "../downloads/media-queue.js";
import { YoutubeService } from "../integrations/youtube/youtube-service.js";
import { TransferSender } from "../transfers/transfer-delivery.js";
import { TransferStore } from "../transfers/transfer-store.js";
import { toolsByName } from "./index.js";
import { decidePendingAction, runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

const tool = (name: string) => toolsByName.get(name as never) as AnyToolDefinition;
const now = new Date("2026-11-26T12:00:00Z");
const ANA = "5490000000001@s.whatsapp.net";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(options: { gmail?: { sent: unknown[] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-transfer-tools-"));
  dirs.push(dir);
  const db = openMigratedDatabase(":memory:");
  db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('conv-1', ?, ?)").run(now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO wa_sync_state (source, status, last_event_at) VALUES ('baileys', 'connected', ?)").run(now.toISOString());
  db.prepare("INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES (?, 'Ana Vivo', 0, ?)").run(ANA, now.toISOString());
  const store = new TransferStore(db);
  const attachments = new AttachmentStore(db, join(dir, "attachments"));
  const gmail = options.gmail;
  const sender = new TransferSender({
    db,
    store,
    attachments,
    dir,
    publicOrigin: "https://jarvis.example",
    ...(gmail ? { gmail: { send: async (_label: unknown, mail: unknown) => (gmail.sent.push(mail), { id: "m1", threadId: "t1", from: "owner@example.com" }) } } : {}),
  });
  const downloader = {
    run: (_job: unknown, _work: string, _progress: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DownloadError("cancelled")))),
  } as unknown as MediaDownloader;
  const media = new MediaQueue({ db, store, dir, downloader, freeBytes: () => 100 * 1024 ** 3, now: () => now });
  const choices = new MediaChoices(db, media);
  const youtubeFetch: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).includes("/videos?")
          ? { items: [{ id: "aqz-KE-bpKQ", contentDetails: { duration: "PT4M13S" } }] }
          : {
              items: [
                { id: { videoId: "aqz-KE-bpKQ" }, snippet: { title: "Crimen (en vivo)", channelTitle: "Cerati" } },
                { id: { videoId: "C64IB36LzCQ" }, snippet: { title: "Crimen", channelTitle: "Gustavo Cerati" } },
              ],
            },
      ),
    );
  const youtube = new YoutubeService({ apiKey: "key.example.test", fetchFn: youtubeFetch });
  const cards: { kind: string; details?: { label: string; value: string }[]; choiceId?: string; options?: { title: string }[] }[] = [];
  const ctx: ToolContext = {
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], attachments, youtube, transfers: { store, publicOrigin: "https://jarvis.example", media, sender, choices } },
    conversationId: "conv-1",
    turnId: "turn-1",
    now: () => now,
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card as (typeof cards)[number]),
    emitPlayerCommand: () => {},
  };
  const file = (name: string, mediaType: string, size: number) => {
    const uploadId = `up-${name}`;
    writeFileSync(join(dir, uploadId), Buffer.alloc(Math.min(size, 1024), 1));
    return store.add({ origin: "download", sender: "YouTube", name, mediaType, size: Math.min(size, 1024), uploadId }, now);
  };
  const outbox = () => db.prepare("SELECT chat_jid AS chat, text, attachment_id AS attachment FROM wa_outbox").all() as { chat: string; text: string; attachment: string | null }[];
  return { db, dir, store, media, sender, choices, ctx, cards, file, outbox };
}

const error = (result: ToolResult<unknown>) => (result.ok ? undefined : result.error);

describe("sending Transferencias files", () => {
  it("sends a song by WhatsApp as the file itself", async () => {
    const env = setup();
    const song = env.file("Crimen.mp3", "audio/mpeg", 800);
    const result = await runTool(env.ctx, tool("transfer_send"), { transferId: song.id, channel: "whatsapp", to: "Ana Vivo", text: "escuchá esta" });
    expect(result).toMatchObject({ ok: true, items: [{ to: "Ana Vivo", channel: "WhatsApp", sent: "el archivo" }] });
    const [message] = env.outbox();
    expect(message).toMatchObject({ chat: ANA, text: "escuchá esta" });
    expect(env.ctx.services.attachments?.get(message!.attachment!)).toMatchObject({ name: "Crimen.mp3", mediaType: "audio/mpeg" });
  });

  it("sends a link in original quality when the video is too heavy for WhatsApp", async () => {
    const env = setup();
    const video = env.file("viaje.mp4", "video/mp4", 1024);
    env.db.prepare("UPDATE transfers SET size = ? WHERE id = ?").run(300 * 1024 ** 2, video.id);
    const outcome = await env.sender.send(env.store.get(video.id, now)!, { channel: "whatsapp", to: ANA, name: "Ana Vivo" }, now);
    expect(outcome).toEqual({ ok: true, via: "link" });
    const [message] = env.outbox();
    expect(message?.attachment).toBeNull();
    expect(message?.text).toMatch(/^«viaje\.mp4» en calidad original: https:\/\/jarvis\.example\/\S+ \(se puede bajar durante 24 h\)$/);
  });

  it("mails the file, and explains when Gmail is not set up", async () => {
    const sent: unknown[] = [];
    const env = setup({ gmail: { sent } });
    const song = env.file("Crimen.mp3", "audio/mpeg", 500);
    const result = await runTool(env.ctx, tool("transfer_send"), { transferId: song.id, channel: "email", to: "ana@example.com" });
    expect(result.ok).toBe(false);
    expect(error(result)?.message).toContain("Gmail no está configurado");

    env.ctx.services.gmail = {} as never;
    expect((await runTool(env.ctx, tool("transfer_send"), { transferId: song.id, channel: "email", to: "ana@example.com" })).ok).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ to: ["ana@example.com"], subject: "Crimen.mp3", files: [expect.objectContaining({ name: "Crimen.mp3" })] })]);
  });
});

describe("transfer_from_link", () => {
  it("asks for a link or a search, never both, and only from the three sites", async () => {
    const env = setup();
    expect(error(await runTool(env.ctx, tool("transfer_from_link"), {}))?.code).toBe("invalid_input");
    expect(error(await runTool(env.ctx, tool("transfer_from_link"), { url: "https://youtu.be/aqz-KE-bpKQ", search: "Crimen" }))?.code).toBe("invalid_input");
    expect(error(await runTool(env.ctx, tool("transfer_from_link"), { url: "https://vimeo.com/1" }))?.message).toBe("Solo bajo de YouTube, X o Instagram.");
    await env.media.stop();
  });

  it("after reading third-party content, shows the whole plan on one card and sends only to the confirmed chat", async () => {
    const env = setup();
    env.ctx.security.tainted = true;
    const result = await runTool(env.ctx, tool("transfer_from_link"), { search: "Cerati Crimen", format: "mp3", sendTo: { channel: "whatsapp", to: "Ana Vivo" } });
    expect(error(result)?.code).toBe("needs_confirmation");
    expect(env.media.recent()).toEqual([]);
    expect(env.cards[0]?.details).toEqual([
      { label: "Formato", value: "Audio MP3" },
      { label: "Después", value: "Mandárselo a Ana Vivo por WhatsApp" },
    ]);

    const decided = await decidePendingAction(env.ctx, toolsByName, error(result)!.actionId!, "confirm");
    expect(decided.status).toBe("executed");
    expect(env.media.recent()[0]).toMatchObject({ source: "search", target: "Cerati Crimen", format: "mp3", send: { channel: "whatsapp", to: ANA, name: "Ana Vivo" } });
    await env.media.stop();
  });

  it("downloads for the iPhone unless the owner asks for the maximum", async () => {
    const env = setup();
    await runTool(env.ctx, tool("transfer_from_link"), { url: "https://x.com/a/status/1" });
    expect(env.media.recent()[0]).toMatchObject({ site: "X", format: "iphone" });
    await env.media.stop();
  });
});

describe("transfer_convert", () => {
  it("only makes iPhone videos out of videos, and audio out of videos or songs", async () => {
    const env = setup();
    const song = env.file("Crimen.mp3", "audio/mpeg", 500);
    const notes = env.file("notas.pdf", "application/pdf", 500);
    expect(error(await runTool(env.ctx, tool("transfer_convert"), { transferId: song.id, format: "iphone" }))?.message).toBe("Para el iPhone solo convierto videos.");
    expect(error(await runTool(env.ctx, tool("transfer_convert"), { transferId: notes.id, format: "mp3" }))?.message).toBe("Solo le saco el audio a videos y audios.");
    expect(await runTool(env.ctx, tool("transfer_convert"), { transferId: song.id, format: "m4a" })).toMatchObject({ ok: true, items: [{ format: "Audio M4A" }] });
    await env.media.stop();
  });
});

describe("transfer_suggest", () => {
  it("shows the likely videos on a card, and the owner's tap downloads one, only once", async () => {
    const env = setup();
    const result = await runTool(env.ctx, tool("transfer_suggest"), { query: "crimen cerati", format: "mp3", sendTo: { channel: "whatsapp", to: "Ana Vivo" } });
    expect(result).toMatchObject({ ok: true, items: [{ option: 1, title: "Crimen (en vivo)", duration: "4:13" }, { option: 2, title: "Crimen", duration: null }] });
    expect(env.ctx.security.taintSources.has("transfer_suggest")).toBe(true);
    const card = env.cards[0]!;
    expect(card).toMatchObject({ kind: "media_choice", format: "mp3", sendTo: "Ana Vivo", options: [{ title: "Crimen (en vivo)" }, { title: "Crimen" }] });

    const picked = env.choices.choose(card.choiceId!, 1, now);
    expect(picked.ok).toBe(true);
    expect(env.media.recent()[0]).toMatchObject({ source: "link", target: "https://www.youtube.com/watch?v=C64IB36LzCQ", format: "mp3", send: { to: ANA, name: "Ana Vivo" } });
    expect(env.choices.choose(card.choiceId!, 0, now)).toMatchObject({ ok: false, reason: "chosen" });
    expect(env.choices.card(env.choices.get(card.choiceId!)!).chosen).toBe(1);
    expect(env.choices.choose(card.choiceId!, 2, now)).toMatchObject({ ok: false, reason: "not_found" });
    await env.media.stop();
  });

  it("lets a proposal expire after a day", async () => {
    const env = setup();
    await runTool(env.ctx, tool("transfer_suggest"), { query: "crimen" });
    const late = new Date(now.getTime() + 25 * 3_600_000);
    expect(env.choices.choose(env.cards[0]!.choiceId!, 0, late)).toMatchObject({ ok: false, reason: "expired" });
    await env.media.stop();
  });
});

describe("transfer_edit", () => {
  it("needs one source and either what to find or the exact times", async () => {
    const env = setup();
    const video = env.file("partido.mp4", "video/mp4", 500);
    const song = env.file("Crimen.mp3", "audio/mpeg", 500);
    const refused = async (input: object) => error(await runTool(env.ctx, tool("transfer_edit"), input))?.message;
    expect(await refused({ find: "el gol" })).toBe("Pasá una sola fuente: url, search o transferId.");
    expect(await refused({ url: "https://youtu.be/aqz-KE-bpKQ", transferId: video.id, find: "el gol" })).toBe("Pasá una sola fuente: url, search o transferId.");
    expect(await refused({ url: "https://youtu.be/aqz-KE-bpKQ" })).toBe("Pasá find (qué buscar) o segments (los tiempos), uno de los dos.");
    expect(await refused({ transferId: video.id, segments: [{ start: 20, end: 10 }] })).toBe("Cada parte tiene que terminar después de empezar.");
    expect(await refused({ transferId: song.id, find: "el estribillo" })).toBe("Solo edito videos, o audios si es para sacar un MP3.");
    expect((await runTool(env.ctx, tool("transfer_edit"), { transferId: song.id, find: "el estribillo", format: "mp3" })).ok).toBe(true);
    await env.media.stop();
  });

  it("shows the whole plan on one card after third-party content, and queues it as confirmed", async () => {
    const env = setup();
    env.ctx.security.tainted = true;
    const result = await runTool(env.ctx, tool("transfer_edit"), { url: "https://youtu.be/aqz-KE-bpKQ", find: "el gol de Paredes de penal", sendTo: { channel: "whatsapp", to: "me" } });
    expect(env.cards[0]?.details).toEqual([
      { label: "Quedarme con", value: "el gol de Paredes de penal" },
      { label: "Formato", value: "Video para el iPhone" },
      { label: "El video entero", value: "No se guarda" },
      { label: "Después", value: "Mandárselo a vos por WhatsApp" },
    ]);
    await decidePendingAction(env.ctx, toolsByName, error(result)!.actionId!, "confirm");
    expect(env.media.recent()[0]).toMatchObject({
      source: "link",
      format: "iphone",
      edit: { find: "el gol de Paredes de penal", padding: 2, vertical: false, keepSource: false },
      send: { channel: "whatsapp", to: "me", name: "vos" },
    });
    await env.media.stop();
  });
});
