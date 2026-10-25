import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtinTools } from "@jarvis/contracts";
import { pino } from "pino";
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
import { EngineTextToSpeech } from "../voice/engine-tts.js";
import { FixtureSpeechEngine, FixtureStt, type FixtureEngineOptions } from "../voice/fixture-providers.js";
import { registerDeviceRoutes } from "./device-gateway.js";
import { DeviceStore } from "./device-store.js";

export const OWNER_PASSWORD = "correct horse battery staple";
export const OWNER_ORIGIN = "http://localhost:5173";
const passwordHash = await hashPassword(OWNER_PASSWORD);
const assistantDir = resolve(import.meta.dirname, "../../../../assistant");

export interface DeviceTestServerOptions {
  engine?: FixtureEngineOptions;
  reply?: string;
  transcript?: string;
}

/** Real Fastify app on an ephemeral port with fixture STT/TTS and the scripted runtime. */
export async function startDeviceTestServer(options: DeviceTestServerOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-device-test-"));
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, PORT: "8080", PUBLIC_ORIGIN: OWNER_ORIGIN, OWNER_PASSWORD_HASH: passwordHash, LOG_LEVEL: "fatal" });
  const db = openMigratedDatabase(config.dbPath);
  const store = new ConversationStore(db);
  const hub = new ConversationHub();
  const logger = pino({ level: "silent" });
  const engine = new FixtureSpeechEngine(options.engine);
  const stt = new FixtureStt({ transcript: options.transcript ?? "¿Qué hora es?" });
  const tts = new EngineTextToSpeech({ provider: "fixture", engine, effectIntensity: 0.15 });
  const orchestrator = new ConversationOrchestrator({
    store,
    hub,
    runtime: new ScriptedRuntime(() => ({ text: options.reply ?? "Son las diez de la noche. Algo más en lo que te ayude?" })),
    toolRegistry: new TurnToolRegistry(),
    services: { db, timezone: config.timezone, backupRetentionDays: 30, statusSources: [] },
    tools: allTools,
    builtinTools,
    ownerName: "Alex",
    sessionMaxTurns: 40,
    log: logger,
  });
  const devices = new DeviceStore(db);
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
    stt,
    tts,
    orchestrator,
    registerRoutes: (instance, helpers) =>
      registerDeviceRoutes(instance, helpers, {
        devices,
        connection: { store, hub, orchestrator, stt, tts, ownerName: "Alex", followUpWindowMs: config.followUpWindowMs, pushPublicKey: null, log: logger },
      }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    db,
    devices,
    engine,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/device`,
    async ownerCookie(): Promise<string> {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: OWNER_ORIGIN },
        body: JSON.stringify({ password: OWNER_PASSWORD }),
      });
      return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    },
    terminateClients(): void {
      for (const client of app.websocketServer.clients) client.terminate();
    },
    async close(): Promise<void> {
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
