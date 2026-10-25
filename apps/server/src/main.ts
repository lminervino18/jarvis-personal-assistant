import { resolve } from "node:path";
import { builtinTools, type ModelRuntime } from "@jarvis/contracts";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { TokenCipher } from "./crypto/token-cipher.js";
import { ConversationStore } from "./conversation/conversation-store.js";
import { ConversationHub } from "./conversation/hub.js";
import { ConversationOrchestrator } from "./conversation/orchestrator.js";
import { TurnToolRegistry } from "./conversation/turn-tool-registry.js";
import { openMigratedDatabase } from "./db/database.js";
import { registerDeviceRoutes } from "./devices/device-gateway.js";
import { DeviceStore } from "./devices/device-store.js";
import { createGmailIntegration } from "./integrations/gmail/setup.js";
import { PairingStore } from "./integrations/whatsapp/pairing-store.js";
import { WhatsAppStatusSource } from "./integrations/whatsapp/status.js";
import { YoutubeService } from "./integrations/youtube/youtube-service.js";
import { ClaudeAgentRuntime, type Effort } from "./runtime/claude-runtime.js";
import { ScriptedRuntime } from "./runtime/scripted-runtime.js";
import { defaultAssistantDir, loadAssistantContext } from "./runtime/system-prompt.js";
import { createLogger } from "./logger.js";
import { SystemMessageFeed } from "./push/live-feed.js";
import { AgendaStatusSource, PushStatusSource } from "./push/status.js";
import { PushSubscriptionStore } from "./push/subscriptions.js";
import { loadVapidConfig } from "./push/vapid.js";
import { allTools } from "./tools/index.js";
import type { ToolServices } from "./tools/types.js";
import { createVoiceServices } from "./voice/providers.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const db = openMigratedDatabase(config.dbPath);
const assistantDir = process.env.ASSISTANT_DIR ? resolve(process.env.ASSISTANT_DIR) : defaultAssistantDir();
const assistantContext = () =>
  loadAssistantContext({
    instructionsPath: resolve(assistantDir, "CLAUDE.md"),
    privateProfilePath: resolve(config.dataDir, "memory", "loren.md"),
    exampleProfilePath: resolve(assistantDir, "loren.example.md"),
    allowExampleProfile: config.env !== "production",
    ownerDisplayName: config.ownerDisplayName,
    timezone: config.timezone,
  });

const tokenCipher = TokenCipher.fromEnv(process.env);
const gmail = createGmailIntegration({
  db,
  env: process.env,
  cipher: tokenCipher,
  publicOrigin: config.publicOrigin,
  timezone: config.timezone,
});

const whatsapp = new WhatsAppStatusSource(db, config.timezone, tokenCipher ? new PairingStore(db, tokenCipher) : undefined);
const youtube = new YoutubeService({ apiKey: process.env.YOUTUBE_API_KEY });

const services: ToolServices = {
  db,
  timezone: config.timezone,
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
  statusSources: [gmail.statusSource, whatsapp, youtube],
  gmail: gmail.service,
  youtube,
};

const vapid = loadVapidConfig();
const pushSubscriptions = new PushSubscriptionStore(db);
services.statusSources.push(new PushStatusSource(db, vapid), new AgendaStatusSource(db, config.timezone));

const voice = createVoiceServices(process.env, { allowFixtures: config.env !== "production" });
const externalTts = voice.tts.provider === "elevenlabs";
const textOnlySources = new Set(
  (process.env.VOICE_TEXT_ONLY_SOURCES ?? (externalTts ? "gmail_search,gmail_get_thread" : ""))
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean),
);
for (const warning of voice.warnings) logger.warn(warning);

const toolRegistry = new TurnToolRegistry();
const runtime: ModelRuntime =
  config.runtime === "scripted"
    ? new ScriptedRuntime()
    : new ClaudeAgentRuntime({
        workspaceDir: config.claude.workspaceDir,
        timezone: config.timezone,
        model: config.claude.model,
        effort: (process.env.CLAUDE_EFFORT as Effort | undefined) ?? "low",
        maxTurns: config.claude.maxTurns,
        allowOverage: config.claude.allowOverage,
        configDir: config.claude.configDir,
        oauthToken: config.claude.oauthToken,
        systemPrompt: () => assistantContext().prompt,
        toolsetFor: (input) => toolRegistry.require(input.turnId),
      });

const store = new ConversationStore(db);
const hub = new ConversationHub();
const systemMessageFeed = new SystemMessageFeed(db, hub, logger);

const orchestrator = new ConversationOrchestrator({
  store,
  hub,
  runtime,
  toolRegistry,
  services,
  tools: allTools,
  builtinTools,
  ownerName: config.ownerDisplayName,
  sessionMaxTurns: config.claude.sessionMaxTurns,
  textOnlySources,
  log: logger,
});
const devices = new DeviceStore(db);

const app = await buildApp({
  config,
  logger,
  db,
  store,
  hub,
  assistantContext,
  registerRoutes: async (instance, helpers) => {
    await gmail.registerRoutes(instance, helpers);
    registerDeviceRoutes(instance, helpers, {
      devices,
      connection: {
        store,
        hub,
        orchestrator,
        stt: voice.stt,
        tts: voice.tts,
        ownerName: config.ownerDisplayName,
        followUpWindowMs: config.followUpWindowMs,
        pushPublicKey: null,
        log: logger,
      },
    });
  },
  onPlayerState: youtube.onPlayerState,
  stt: voice.stt,
  tts: voice.tts,
  pushPublicKey: vapid?.publicKey ?? null,
  onPushSubscribe: async (subscription, userAgent) => pushSubscriptions.save(subscription, userAgent),
  orchestrator,
});

const context = assistantContext();
app.log.info({ runtime: runtime.name, profile: context.profileSource, fingerprint: context.fingerprint }, "assistant context loaded");

app.log.info({ stt: voice.stt.provider, tts: voice.tts.provider }, "voice providers loaded");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  systemMessageFeed.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
systemMessageFeed.start();
