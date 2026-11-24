import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoBrief, type Card } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { FileLinks } from "../files/file-links.js";
import type { GmailService } from "../integrations/gmail/gmail-service.js";
import type { ToolContext } from "../tools/types.js";
import { videoCreate, videoSend, videoStatus } from "../tools/video-tools.js";
import { deliveryFor, sendRequestedVideos, sendVideo } from "./video-delivery.js";
import { encodeWav } from "../voice/pcm.js";
import { Narrator, type Narration } from "./narrator.js";
import { videoPageHtml } from "./video-page.js";
import { versionDir } from "./video-paths.js";
import { VideoPipeline } from "./video-pipeline.js";
import { wordRecall, type Exec } from "./video-qa.js";
import { VideoStore } from "./video-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-videos-"));
  dirs.push(dir);
  return dir;
}

const NOW = new Date("2026-11-23T12:00:00Z");
const silent = { info: () => {}, warn: () => {} };

const BRIEF = VideoBrief.parse({
  title: "Torneo de pádel",
  audience: "el grupo del club",
  goal: "ask",
  message: "Hay torneo el sábado y necesito saber quién juega.",
  facts: ["Sábado 28 a las 10"],
  purpose: "invitarte al torneo",
  scenes: [
    { type: "title", emoji: "🎾", title: "Torneo del sábado", narration: "El sábado veintiocho hay torneo en el club." },
    { type: "question", question: "¿Jugás?", options: [{ label: "Sí, juego" }, { label: "No puedo" }], narration: "¿Jugás? Decime sí, juego o no puedo." },
  ],
  links: [{ label: "Reglamento <b>", url: "https://example.test/reglamento" }],
});

function setup() {
  const db = openMigratedDatabase(":memory:");
  const dir = tempDir();
  const store = new VideoStore(db);
  const attachments = new AttachmentStore(db, join(dir, "attachments"));
  return { db, dir, store, attachments };
}

describe("video store", () => {
  it("queues a version, works it under a lease, and a revision cancels the older one", () => {
    const { store } = setup();
    const first = store.create(BRIEF, "Loren", NOW);
    expect(store.card(first.videoId)).toMatchObject({ kind: "video", version: 1, status: "queued", format: "vertical", files: {} });
    const claimed = store.claimNext(NOW, 60_000);
    expect(claimed).toMatchObject({ videoId: first.videoId, status: "voice", attempts: 1 });
    expect(store.claimNext(NOW, 60_000)).toBeUndefined();
    const second = store.revise(first.videoId, { ...BRIEF, title: "Torneo (corto)" }, NOW);
    expect(second?.version).toBe(2);
    expect(store.version(first.videoId, 1)?.status).toBe("cancelled");
    expect(store.stage(first.videoId, 1, "render", 0.5, NOW, 60_000)).toBe(false);
    expect(store.get(first.videoId)?.title).toBe("Torneo (corto)");
  });

  it("retries a version whose worker died, but not forever", () => {
    const { store } = setup();
    const { videoId } = store.create(BRIEF, "Loren", NOW);
    store.claimNext(NOW, 1000);
    const later = new Date(NOW.getTime() + 5000);
    expect(store.claimNext(later, 1000)?.attempts).toBe(2);
    expect(store.claimNext(new Date(later.getTime() + 5000), 1000)).toBeUndefined();
    expect(store.version(videoId)?.status).toBe("failed");
  });
});

describe("narrator", () => {
  it("narrates with real word timings and pays for each text only once", async () => {
    const samples = new Int16Array(2400).fill(1000);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const characters = [..."Hola, Loren."];
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from(samples.buffer).toString("base64"),
          alignment: { characters, character_start_times_seconds: characters.map((_, i) => i * 0.01), character_end_times_seconds: characters.map((_, i) => i * 0.01 + 0.008) },
        }),
      );
    }) as typeof fetch;
    const narrator = new Narrator({ apiKey: "k", voiceId: "voice-1", model: "eleven_flash_v2_5", languageCode: "es", effectIntensity: 0.35, fetch: fakeFetch }, tempDir());
    const first = await narrator.narrate("Hola, Loren. 🎉");
    expect(first).toMatchObject({ durationMs: 100, cached: false, words: [{ text: "Hola,", startMs: 0, endMs: 48 }, { text: "Loren.", startMs: 60, endMs: 118 }] });
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-1/with-timestamps?output_format=pcm_24000");
    expect(calls[0]?.body).toMatchObject({ text: "Hola, Loren.", model_id: "eleven_flash_v2_5", language_code: "es" });
    expect(existsSync(first.path)).toBe(true);
    expect((await narrator.narrate("Hola, Loren.")).cached).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

function fakeNarrator(dir: string) {
  return {
    narrate: async (text: string): Promise<Narration> => {
      const file = `${Buffer.from(text).toString("hex").slice(0, 24)}.wav`;
      writeFileSync(join(dir, file), encodeWav(new Uint8Array(4800), 24000));
      const words = text.split(" ").map((word, index) => ({ text: word, startMs: index * 300, endMs: index * 300 + 250 }));
      return { file, path: join(dir, file), durationMs: words.length * 300, words, characters: text.length, cached: false };
    },
  } as unknown as Narrator;
}

function fakeExec(store: VideoStore, videoId: string, codec = "h264"): Exec {
  return async (command, args) => {
    if (command === "ffprobe") {
      const duration = (store.version(videoId)?.durationMs ?? 0) / 1000;
      return {
        stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: codec, width: 1080, height: 1920, pix_fmt: "yuv420p" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: String(duration) } }),
        stderr: "",
      };
    }
    if (args.includes("null")) return { stdout: "", stderr: "[Parsed_volumedetect_1] max_volume: -3.2 dB" };
    writeFileSync(args.at(-1) as string, Buffer.from(`fake ${args.at(-1)}`));
    return { stdout: "", stderr: "" };
  };
}

describe("video pipeline", () => {
  it("turns a queued video into checked files, tells the owner and keeps the narration for the preview", async () => {
    const { db, dir, store, attachments } = setup();
    const { videoId } = store.create(BRIEF, "Loren", NOW);
    const claimed = store.claimNext(NOW, 60_000)!;
    const pipeline = new VideoPipeline({
      db,
      store,
      attachments,
      narrator: fakeNarrator(tempDir()),
      exec: fakeExec(store, videoId),
      bundleDir: "bundle",
      videosDir: join(dir, "videos"),
      log: silent,
      now: () => NOW,
      render: async (request) => {
        expect(request.timeline.assetBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const audio = await fetch(`${request.timeline.assetBase}/${request.timeline.scenes[0]?.audio.file}`);
        expect(audio.headers.get("content-type")).toBe("audio/wav");
        request.onProgress(1);
        writeFileSync(request.output, "raw");
      },
    });
    await pipeline.run(claimed);

    const done = store.version(videoId)!;
    expect(done.status).toBe("ready");
    expect(done.qa?.passed).toBe(true);
    expect(done.timeline?.scenes[0]?.content).toMatchObject({ type: "intro", narration: "Hola, soy Jarvis, el asistente personal de Loren. Este mensaje es para invitarte al torneo." });
    expect(attachments.get(done.files.full!.attachmentId)?.name).toBe("torneo-de-padel.mp4");
    expect(attachments.get(done.files.light!.attachmentId)?.name).toBe("torneo-de-padel-liviano.mp4");
    expect(attachments.read(done.files.srt!)?.data.toString()).toContain("Hola, soy Jarvis,");
    const left = readdirSync(versionDir(join(dir, "videos"), videoId, 1));
    expect(left.some((name) => name.endsWith(".wav"))).toBe(true);
    expect(left.some((name) => name.endsWith(".mp4"))).toBe(false);
    const outbox = db.prepare("SELECT kind, payload_json FROM outbox ORDER BY kind").all() as { kind: string; payload_json: string }[];
    expect(outbox.map((row) => row.kind)).toEqual(["chat_message", "push"]);
    const chat = JSON.parse(outbox[0]!.payload_json) as { text: string; cards: Card[] };
    expect(chat.text).toMatch(/^Listo el video «Torneo de pádel» \(0:\d\d\)/);
    expect(chat.cards[0]).toMatchObject({ kind: "video", status: "ready" });
  });

  it("fails without retrying when the final file does not pass the checks", async () => {
    const { db, dir, store, attachments } = setup();
    const { videoId } = store.create(BRIEF, "Loren", NOW);
    const pipeline = new VideoPipeline({
      db,
      store,
      attachments,
      narrator: fakeNarrator(tempDir()),
      exec: fakeExec(store, videoId, "vp9"),
      bundleDir: "bundle",
      videosDir: join(dir, "videos"),
      log: silent,
      now: () => NOW,
      render: async (request) => writeFileSync(request.output, "raw"),
    });
    await pipeline.run(store.claimNext(NOW, 60_000)!);
    expect(store.version(videoId)).toMatchObject({ status: "failed", error: expect.stringContaining("archivo") });
  });
});

describe("video quality and page", () => {
  it("measures how much of the script the recognizer heard", () => {
    expect(wordRecall("Hola, soy Jarvis, el asistente personal de Loren.", "hola soy jarvis el asistente personal de loren")).toBe(1);
    expect(wordRecall("Hola, soy Jarvis", "otra cosa")).toBe(0);
  });

  it("builds the interactive page with the options and every text escaped", () => {
    const { store } = setup();
    const version = store.create(BRIEF, "Loren", NOW);
    const html = videoPageHtml(version, "Loren <3", { video: "/torneo/f/abc", poster: "/torneo/f/def" });
    expect(html).toContain('<video src="/torneo/f/abc" poster="/torneo/f/def" controls playsinline');
    expect(html).toContain('value="si_juego"');
    expect(html).toContain('name="video_version" value="1"');
    expect(html).toContain("Reglamento &#60;b&#62;");
    expect(html).toContain("Loren &#60;3");
  });
});

describe("video tools", () => {
  function toolContext() {
    const { db, store, attachments } = setup();
    const cards: Card[] = [];
    const sent: unknown[] = [];
    const gmail = {
      cannotSend: () => undefined,
      send: async (_account: string, message: unknown) => {
        sent.push(message);
        return { id: "mail-1", threadId: "th-1", from: "dueno@example.test" };
      },
    } as unknown as GmailService;
    const ctx: ToolContext = {
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], attachments, videos: store, ownerName: "Loren", gmail, fileLinks: new FileLinks(db), filesBaseUrl: "https://p.example.test" },
      conversationId: "c1",
      turnId: "t1",
      now: () => NOW,
      security: { tainted: false, taintSources: new Set() },
      emitCard: (card) => cards.push(card),
      emitPlayerCommand: () => {},
    };
    return { ctx, store, attachments, cards, sent };
  }

  function makeReady(store: VideoStore, attachments: AttachmentStore, fullBytes: number) {
    const { videoId } = store.create(BRIEF, "Loren", NOW);
    store.claimNext(NOW, 60_000);
    const full = attachments.save({ name: "torneo.mp4", mediaType: "video/mp4", data: Buffer.alloc(fullBytes) }, NOW, Infinity)!;
    const light = attachments.save({ name: "torneo-liviano.mp4", mediaType: "video/mp4", data: Buffer.alloc(1000) }, NOW)!;
    const thumb = attachments.save({ name: "torneo.jpg", mediaType: "image/jpeg", data: Buffer.from("jpg") }, NOW)!;
    store.finish(videoId, 1, { files: { full: { attachmentId: full.id, size: full.size }, light: { attachmentId: light.id, size: light.size }, thumbnail: thumb.id }, qa: { passed: true, checks: [] }, usage: { ttsCharacters: 0, ttsCachedCharacters: 0, renderSeconds: 0, bytes: 0 } }, NOW);
    return { videoId, full, light, thumb };
  }

  it("creates a video in the background and shows its card right away", async () => {
    const { ctx, cards, store } = toolContext();
    const result = await videoCreate.execute(ctx, { brief: BRIEF });
    expect(result.ok).toBe(true);
    expect(cards[0]).toMatchObject({ kind: "video", status: "queued", title: "Torneo de pádel" });
    const listed = await videoStatus.execute(ctx, {});
    expect(listed.ok && listed.items).toHaveLength(1);
    expect(store.list(5)[0]?.status).toBe("queued");
  });

  it("refuses scenes that point at files that are not photos or videos", async () => {
    const { ctx, attachments } = toolContext();
    const pdf = attachments.save({ name: "menu.pdf", mediaType: "application/pdf", data: Buffer.from("pdf") }, NOW)!;
    const brief = { ...BRIEF, scenes: [{ type: "media" as const, attachmentId: pdf.id, focus: "center" as const, narration: "Este es el menú." }] };
    const result = await videoCreate.execute(ctx, { brief });
    expect(result.ok ? "" : result.error.message).toContain("no es una foto ni un video");
  });

  it("picks the file each channel can carry", () => {
    const { store, attachments } = toolContext();
    const { videoId, light } = makeReady(store, attachments, 18 * 1024 * 1024);
    const version = store.latestReady(videoId)!;
    expect(deliveryFor(version, "whatsapp")).toMatchObject({ file: "light", attachmentId: light.id });
    expect(deliveryFor(version, "email")).toMatchObject({ file: "full" });
    expect(deliveryFor({ ...version, files: {} }, "email")).toEqual({ file: "link" });
  });

  it("mails the video with a link once, even if the send is retried", async () => {
    const { ctx, store, attachments, sent } = toolContext();
    const { videoId, full } = makeReady(store, attachments, 2000);
    const input = { videoId, channel: "email" as const, to: "ana@example.test", text: "Te paso el video del torneo." };
    const prepared = videoSend.prepare!(ctx, input);
    expect("input" in prepared).toBe(true);
    const first = await videoSend.execute(ctx, { ...input, account: "personal" });
    expect(first.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["ana@example.test"], subject: "Torneo de pádel", files: [{ name: "torneo.mp4" }] });
    expect((sent[0] as { body: string }).body).toMatch(/Ver o bajar el video: https:\/\/p\.example\.test\/d\/[\w-]+/);
    const again = await videoSend.execute(ctx, { ...input, account: "personal" });
    expect(again.ok && again.note).toContain("ya se había hecho");
    expect(sent).toHaveLength(1);
    expect(store.deliveries(videoId)).toMatchObject([{ channel: "email", file: "full", status: "sent", providerId: "mail-1" }]);
    expect(full.size).toBe(2000);
  });

  it("sends a video the owner asked to send as soon as it is ready, only once", async () => {
    const { ctx, store, attachments, cards, sent } = toolContext();
    const created = await videoCreate.execute(ctx, { brief: BRIEF, sendTo: { channel: "email", to: "ana@example.test", text: "Mirá esto" } });
    expect(created.ok && created.note).toContain("se lo manda solo a ana@example.test");
    expect(cards[0]).toMatchObject({ kind: "video", send: { channel: "email", recipient: "ana@example.test", text: "Mirá esto", status: "pending" } });
    const videoId = (cards[0] as { videoId: string }).videoId;
    store.claimNext(NOW, 60_000);
    const full = attachments.save({ name: "torneo.mp4", mediaType: "video/mp4", data: Buffer.alloc(500) }, NOW)!;
    store.finish(videoId, 1, { files: { full: { attachmentId: full.id, size: full.size } }, qa: { passed: true, checks: [] }, usage: { ttsCharacters: 0, ttsCachedCharacters: 0, renderSeconds: 0, bytes: 0 } }, NOW);

    const inFlight = new Set<string>();
    await sendRequestedVideos(ctx.services, inFlight, NOW);
    expect(store.card(videoId)?.send?.status).toBe("sent");
    expect(sent).toHaveLength(1);
    await sendRequestedVideos(ctx.services, inFlight, NOW);
    const request = store.get(videoId)!.send!;
    expect(await sendVideo(ctx.services, { videoId, version: 1, channel: request.channel, to: request.to, text: request.text! }, NOW)).toMatchObject({ ok: true, repeated: true });
    expect(sent).toHaveLength(1);
  });

  it("refuses a video whose scenes only repeat the intro", async () => {
    const { ctx } = toolContext();
    const brief = { ...BRIEF, purpose: "contarles que la pasé muy bien en el asado", scenes: [{ type: "title" as const, title: "La pasé muy bien en el asado", narration: "La pasé muy bien en el asado." }] };
    const result = await videoCreate.execute(ctx, { brief });
    expect(result.ok ? "" : result.error.message).toContain("repite lo que ya dice la presentación");
  });

  it("does not send a video that is not ready", () => {
    const { ctx, store } = toolContext();
    const { videoId } = store.create(BRIEF, "Loren", NOW);
    const prepared = videoSend.prepare!(ctx, { videoId, channel: "email", to: "ana@example.test", text: "Hola" });
    expect("refused" in prepared && prepared.refused.ok === false && prepared.refused.error.message).toContain("todavía no está listo");
  });
});
