import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BinaryFrameKind, builtinTools, decodeAudioFrame, encodeAudioFrame, type AudioFormat, type ServerMessage } from "@jarvis/contracts";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { ConversationStore } from "../conversation/conversation-store.js";
import { ConversationHub } from "../conversation/hub.js";
import { ConversationOrchestrator } from "../conversation/orchestrator.js";
import { TurnToolRegistry } from "../conversation/turn-tool-registry.js";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { loadAssistantContext } from "../runtime/system-prompt.js";
import { allTools } from "../tools/index.js";
import { EngineTextToSpeech } from "./engine-tts.js";
import { FixtureSpeechEngine, FixtureStt, type FixtureEngineOptions } from "./fixture-providers.js";
import { toBytes } from "./pcm.js";

const PASSWORD = "correct horse battery staple";
const passwordHash = await hashPassword(PASSWORD);
const assistantDir = resolve(import.meta.dirname, "../../../../assistant");
const MIC_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };
const SPEAKER_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(engineOptions: FixtureEngineOptions = {}, reply = "Son las diez de la noche. Algo más en lo que te ayude?") {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-voice-test-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, PORT: "8080", PUBLIC_ORIGIN: "http://localhost:5173", OWNER_PASSWORD_HASH: passwordHash, LOG_LEVEL: "fatal" });
  const db = openMigratedDatabase(config.dbPath);
  const store = new ConversationStore(db);
  const hub = new ConversationHub();
  const logger = pino({ level: "silent" });
  const engine = new FixtureSpeechEngine(engineOptions);
  const app = await buildApp({
    config,
    logger,
    db,
    store,
    hub,
    assistantContext: () =>
      loadAssistantContext({
        instructionsPath: join(assistantDir, "CLAUDE.md"),
        privateProfilePath: join(dataDir, "memory", "loren.md"),
        exampleProfilePath: join(assistantDir, "loren.example.md"),
        allowExampleProfile: true,
        ownerDisplayName: "Alex",
        timezone: config.timezone,
      }),
    stt: new FixtureStt({ transcript: "¿Qué hora es?", partials: ["¿Qué"] }),
    tts: new EngineTextToSpeech({ provider: "fixture", engine, effectIntensity: 0.15 }),
    orchestrator: new ConversationOrchestrator({
      store,
      hub,
      runtime: new ScriptedRuntime(() => ({ text: reply })),
      toolRegistry: new TurnToolRegistry(),
      services: { db, timezone: config.timezone, backupRetentionDays: 30, statusSources: [] },
      tools: allTools,
      builtinTools,
      ownerName: "Alex",
      sessionMaxTurns: 40,
      log: logger,
    }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  cleanups.push(async () => {
    await app.close();
    db.close();
  });
  return { db, engine, port: typeof address === "object" && address ? address.port : 0 };
}

async function login(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

class VoiceClient {
  readonly messages: ServerMessage[] = [];
  readonly frames: { turnId: string; bytes: number; at: number }[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeAudioFrame(new Uint8Array(data as Buffer));
        this.frames.push({ turnId: frame.turnId, bytes: frame.payload.byteLength, at: this.messages.length });
        return;
      }
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
    });
  }

  static async connect(port: number): Promise<VoiceClient> {
    const cookie = await login(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: "http://localhost:5173" } });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen());
      socket.once("error", reject);
    });
    const client = new VoiceClient(socket);
    cleanups.push(() => socket.close());
    return client;
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends ServerMessage["type"]>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = this.messages.find((m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
      if (found) return found as Extract<ServerMessage, { type: T }>;
      await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    }
    throw new Error(`timeout waiting for ${type}`);
  }

  async hello() {
    this.send({ type: "hello", protocol: 1, client: { kind: "web", version: "test" }, audio: { input: [MIC_FORMAT], output: [MIC_FORMAT, SPEAKER_FORMAT] } });
    return this.waitFor("ready");
  }

  speak(conversationId: string, turnId: string, seconds = 1): void {
    this.send({ type: "audio.begin", conversationId, turnId, format: MIC_FORMAT, replyMode: "voice" });
    const chunk = toBytes(new Int16Array(MIC_FORMAT.sampleRate * 0.1).fill(1000));
    for (let i = 0; i < seconds * 10; i++) this.socket.send(encodeAudioFrame(BinaryFrameKind.micAudio, turnId, chunk));
    this.send({ type: "audio.end", turnId });
  }
}

describe("voice over the WebSocket with fixture providers", () => {
  it("transcribes a spoken turn, answers by voice and tags every frame with the turn id", async () => {
    const { db, engine, port } = await startServer({ msPerChar: 15 });
    const client = await VoiceClient.connect(port);
    const ready = await client.hello();
    expect(ready.capabilities).toMatchObject({ stt: true, tts: true, ttsProvider: "fixture", outputFormat: SPEAKER_FORMAT });

    const turnId = crypto.randomUUID();
    client.speak(ready.conversationId, turnId);
    const partial = await client.waitFor("transcript", (m) => !m.final);
    const final = await client.waitFor("transcript", (m) => m.final);
    expect([partial.text, final.text]).toEqual(["¿Qué", "¿Qué hora es?"]);
    const begin = await client.waitFor("audio.begin", (m) => m.turnId === turnId);
    expect(begin).toMatchObject({ format: SPEAKER_FORMAT, processed: true });
    const end = await client.waitFor("audio.end", (m) => m.turnId === turnId);
    expect(end.reason).toBe("complete");
    await client.waitFor("turn.end", (m) => m.turnId === turnId);

    expect(client.frames.length).toBeGreaterThan(0);
    expect(client.frames.every((frame) => frame.turnId === turnId)).toBe(true);
    const beginIndex = client.messages.indexOf(begin);
    const endIndex = client.messages.indexOf(end);
    expect(client.frames.every((frame) => frame.at > beginIndex && frame.at <= endIndex)).toBe(true);
    expect(engine.spoken).toEqual(["Son las diez de la noche.", "Algo más en lo que te ayude?"]);

    const row = db.prepare("SELECT stt_ms, first_text_ms, first_audio_ms FROM turns WHERE id = ?").get(turnId) as Record<string, number | null>;
    expect(row.stt_ms).not.toBeNull();
    expect(row.first_audio_ms as number).toBeGreaterThanOrEqual(row.first_text_ms as number);
  });

  it("stops speaking right away when the owner interrupts", async () => {
    const { port } = await startServer({ msPerChar: 80, chunkDelayMs: 20 }, "Esta es una respuesta larga que se va a interrumpir. Y esta otra parte no debería sonar nunca.");
    const client = await VoiceClient.connect(port);
    const { conversationId } = await client.hello();
    const turnId = crypto.randomUUID();
    client.speak(conversationId, turnId);
    await client.waitFor("audio.begin", (m) => m.turnId === turnId);
    while (client.frames.length < 2) await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    client.send({ type: "turn.cancel", turnId, reason: "barge_in" });
    const end = await client.waitFor("audio.end", (m) => m.turnId === turnId);
    expect(end.reason).toBe("cancelled");
    const framesAtCancel = client.frames.length;
    await new Promise((resolveTick) => setTimeout(resolveTick, 150));
    expect(client.frames.length).toBeLessThanOrEqual(framesAtCancel + 1);
    expect(client.messages.filter((m) => m.type === "audio.end")).toHaveLength(1);
  });

  it("keeps the written answer and reports tts_failed when synthesis breaks", async () => {
    const { port } = await startServer({ failWhen: () => true });
    const client = await VoiceClient.connect(port);
    const { conversationId } = await client.hello();
    const turnId = crypto.randomUUID();
    client.speak(conversationId, turnId);
    const done = await client.waitFor("assistant.done", (m) => m.turnId === turnId);
    expect(done.text).toContain("diez de la noche");
    const error = await client.waitFor("error", (m) => m.turnId === turnId);
    expect(error.code).toBe("tts_failed");
    expect(client.messages.some((m) => m.type === "audio.begin")).toBe(false);
  });
});
