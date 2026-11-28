import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { builtinTools, type ModelRuntime } from "@jarvis/contracts";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { registerEnrollmentRoutes } from "./voice/enrollment-routes.js";
import { PlanUsageReader, registerUsageRoutes } from "./runtime/plan-usage.js";
import { SpeakerCheck, sherpaEmbedder } from "./voice/speaker-check.js";
import { ImageService } from "./images/image-service.js";
import { WhatsAppOutbox } from "./integrations/whatsapp/outbox.js";
import { ProjectShipper } from "./projects/project-shipper.js";
import { RepoProjects } from "./projects/repo-projects.js";
import { createConnections } from "./integrations/connections.js";
import { registerTransferRoutes } from "./transfers/transfer-routes.js";
import { TransferStore } from "./transfers/transfer-store.js";
import { TransferPreviews } from "./transfers/transfer-previews.js";
import { MediaConverter } from "./downloads/media-converter.js";
import { MediaDownloader } from "./downloads/media-downloader.js";
import { MediaChoices } from "./downloads/media-choices.js";
import { MediaQueue } from "./downloads/media-queue.js";
import { BeelupSource } from "./downloads/beelup.js";
import { warpHealer } from "./downloads/warp-control.js";
import { YtDlpUpdater } from "./downloads/ytdlp-updater.js";
import { DriveUploads } from "./integrations/drive/drive-uploads.js";
import { MomentFinder } from "./downloads/moment-finder.js";
import { sarcasticReplier, WhatsAppWatcher } from "./integrations/whatsapp/watcher.js";
import { BridgeMonitor } from "./integrations/whatsapp/bridge-monitor.js";
import { Welcome } from "./welcome/welcome.js";
import { registerWelcomeRoutes } from "./welcome/welcome-routes.js";
import { TransferSender } from "./transfers/transfer-delivery.js";
import { readDiskUsage } from "./worker/disk-watch.js";
import { TokenCipher } from "./crypto/token-cipher.js";
import { ConversationStore } from "./conversation/conversation-store.js";
import { ConversationHub } from "./conversation/hub.js";
import { ConversationOrchestrator } from "./conversation/orchestrator.js";
import { TurnToolRegistry } from "./conversation/turn-tool-registry.js";
import { openMigratedDatabase, workMigrations } from "./db/database.js";
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
import { AttachmentStore } from "./attachments/attachment-store.js";
import { registerAttachmentRoutes } from "./attachments/attachment-routes.js";
import { registerVideoRoutes } from "./videos/video-routes.js";
import { VideoStore } from "./videos/video-store.js";
import { sendRequestedVideos, sendVideo } from "./videos/video-delivery.js";
import { narratorFromEnv } from "./videos/narrator.js";
import { defaultExec } from "./videos/video-qa.js";
import { VoiceNoteMaker } from "./voice/voice-note.js";
import { ChatStudies } from "./integrations/whatsapp/chat-study.js";
import { analyzeFile } from "./files/file-analysis.js";
import { FileLinks } from "./files/file-links.js";
import { baileysDownload, WhatsAppFiles } from "./files/whatsapp-files.js";
import { PageService } from "./pages/page-service.js";
import { PageStore } from "./pages/page-store.js";
import { buildPagesServer } from "./pages/pages-server.js";
import { PublicationSpool } from "./publisher/spool.js";
import { SystemMessageFeed } from "./push/live-feed.js";
import { AgendaStatusSource, PushStatusSource } from "./push/status.js";
import { PushSubscriptionStore } from "./push/subscriptions.js";
import { loadVapidConfig } from "./push/vapid.js";
import { AgentsStatusSource } from "./tasks/agents-status.js";
import { registerTaskRoutes } from "./tasks/task-routes.js";
import { TaskService, type TaskOutcome } from "./tasks/task-service.js";
import { TaskStore } from "./tasks/task-store.js";
import { WorkLayout } from "./tasks/workspace.js";
import { allTools } from "./tools/index.js";
import { currentConfirmCard } from "./tools/runner.js";
import type { ToolServices } from "./tools/types.js";
import { OpenAiCompatibleStt } from "./voice/openai-stt.js";
import { createVoiceServices } from "./voice/providers.js";
import { Outbox } from "./worker/outbox.js";
import type { TaskActionOutcome } from "./ws/client-connection.js";

const PUBLICATION_SYNC_MS = 5_000;

function cardOutcome(service: TaskService, outcome: TaskOutcome): TaskActionOutcome {
  return outcome.ok ? { ok: true, card: service.card(outcome.task), message: outcome.message } : { ok: false, message: outcome.message };
}

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
const connections = createConnections({ db, env: process.env, cipher: tokenCipher, publicOrigin: config.publicOrigin, gmailAccounts: gmail.accounts, whatsapp });
const youtube = new YoutubeService({ apiKey: process.env.YOUTUBE_API_KEY });
const transfers = new TransferStore(db);
const transfersDir = join(config.dataDir, "transfers");
const transferPreviews = new TransferPreviews(transfersDir, defaultExec);
const attachments = new AttachmentStore(db, join(config.dataDir, "attachments"));
const mediaConverter = new MediaConverter({ timeoutMs: 2 * 3_600_000, exec: defaultExec });
const transferSender = new TransferSender({
  db,
  store: transfers,
  attachments,
  dir: transfersDir,
  publicOrigin: config.publicOrigin,
  compress: (input, targetBytes, dir) => mediaConverter.compress(input, targetBytes, dir, AbortSignal.timeout(30 * 60_000)),
  ...(gmail.service ? { gmail: gmail.service } : {}),
});
const ytdlp = process.env.YTDLP_BIN;
const ytdlpUpdater = ytdlp ? new YtDlpUpdater({ dir: join(config.dataDir, "yt-dlp-builds"), bundled: ytdlp }) : undefined;
const media =
  ytdlp && existsSync(ytdlp)
    ? new MediaQueue({
        db,
        store: transfers,
        dir: transfersDir,
        freeBytes: () => readDiskUsage(config.dataDir).freeBytes,
        converter: mediaConverter,
        beelup: new BeelupSource(),
        send: (transfer, request) => transferSender.send(transfer, request, new Date()),
        discard: (transfer) => {
          transfers.markDeleted(transfer.id, new Date());
          rmSync(join(transfersDir, transfer.uploadId), { force: true });
          transferPreviews.remove(transfer.uploadId);
        },
        downloader: new MediaDownloader({
          bin: ytdlp,
          cacheDir: join(config.dataDir, "yt-dlp-cache"),
          maxBytes: 8 * 1024 ** 3,
          timeoutMs: 2 * 3_600_000,
          ...(process.env.YTDLP_YOUTUBE_PROXY ? { youtubeProxy: process.env.YTDLP_YOUTUBE_PROXY } : {}),
          ...(process.env.YTDLP_WARP_CONTROL ? { heal: warpHealer(process.env.YTDLP_WARP_CONTROL) } : {}),
          freshBin: () => ytdlpUpdater?.freshBin() ?? Promise.resolve(undefined),
          ...(process.env.YTDLP_COOKIES_FILE ? { cookiesFile: process.env.YTDLP_COOKIES_FILE } : {}),
        }),
      })
    : undefined;

const mediaChoices = media ? new MediaChoices(db, media) : undefined;
const driveUploads = gmail.drive ? new DriveUploads({ db, client: gmail.drive.client, store: transfers, transfersDir, dir: join(config.dataDir, "drive-uploads") }) : undefined;

const services: ToolServices = {
  db,
  timezone: config.timezone,
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
  statusSources: [gmail.statusSource, whatsapp, youtube, connections.statusSource, ...(gmail.driveStatus ? [gmail.driveStatus] : [])],
  drive: gmail.drive ? { ...gmail.drive, ...(driveUploads ? { uploads: driveUploads } : {}) } : undefined,
  gmail: gmail.service,
  youtube,
  transfers: { store: transfers, publicOrigin: config.publicOrigin, sender: transferSender, ...(media ? { media, choices: mediaChoices } : {}) },
};

const workDb = config.tasks ? openMigratedDatabase(join(config.tasks.workDir, "work.db"), workMigrations) : undefined;
const workLayout = config.tasks ? new WorkLayout(config.tasks.workDir) : undefined;
const tasks =
  config.tasks && workDb && workLayout
    ? new TaskService(
        new TaskStore(workDb),
        workLayout,
        { defaultBudgetUsd: config.tasks.defaultBudgetUsd, maxAttachmentBytes: config.tasks.maxAttachmentBytes },
        config.tasks.publish ? new PublicationSpool(config.tasks.publish.dir, config.tasks.publish.signingKey) : undefined,
        connections.github && connections.accounts
          ? new ProjectShipper({ github: connections.github, vercel: connections.vercel, accounts: connections.accounts, layout: workLayout, projectsDomain: connections.projectsDomain })
          : undefined,
      )
    : undefined;
if (tasks && config.tasks?.publish) setInterval(() => tasks.syncPublications(new Date()), PUBLICATION_SYNC_MS).unref();
if (tasks) setInterval(() => tasks.autoPublish(new Date(), connections.accounts?.get("github")?.account), PUBLICATION_SYNC_MS).unref();
services.tasks = tasks;
if (workLayout && connections.github && connections.accounts) {
  services.repoProjects = new RepoProjects({ github: connections.github, accounts: connections.accounts, projectsDir: workLayout.projectsDir });
}
services.attachments = attachments;
if (tasks) services.statusSources.push(new AgentsStatusSource(tasks));

const speakerModel = process.env.SPEAKER_MODEL ?? "/app/models/speaker.onnx";
const speaker = existsSync(speakerModel)
  ? new SpeakerCheck({
      voiceprintPath: join(config.dataDir, "voice", "voiceprint.json"),
      threshold: Number(process.env.SPEAKER_THRESHOLD ?? 0.35),
      embed: sherpaEmbedder(speakerModel),
    })
  : undefined;
if (speaker?.enrolled()) setTimeout(() => void speaker.matches(Buffer.alloc(32_000), 16_000).catch(() => undefined), 10_000).unref();

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
        summaryModel: config.claude.summaryModel,
        effort: (process.env.CLAUDE_EFFORT as Effort | undefined) ?? "low",
        maxTurns: config.claude.maxTurns,
        allowOverage: config.claude.allowOverage,
        configDir: config.claude.configDir,
        oauthToken: config.claude.oauthToken,
        systemPrompt: () => assistantContext().prompt,
        toolsetFor: (turnId) => toolRegistry.require(turnId),
      });

const pages = config.pages
  ? new PageService({ store: new PageStore(db), attachments, runtime, outbox: new Outbox(db), baseUrl: config.pages.baseUrl, model: config.pages.model, log: logger })
  : undefined;
services.pages = pages;
const fileLinks = new FileLinks(db);
services.fileLinks = fileLinks;
services.filesBaseUrl = config.pages?.baseUrl;
const videos = new VideoStore(db);
const videosDir = join(config.dataDir, "videos");
services.videos = videos;
if (process.env.OPENAI_API_KEY) {
  const whatsappOutbox = new WhatsAppOutbox(db);
  services.images = new ImageService({
    apiKey: process.env.OPENAI_API_KEY,
    attachments,
    outbox: new Outbox(db),
    sendWhatsApp: ({ jid, text, attachmentId }) => whatsappOutbox.enqueue({ id: randomUUID(), chatJid: jid, text, attachmentId }, new Date()),
    log: logger,
    ...(process.env.IMAGE_MODEL ? { model: process.env.IMAGE_MODEL } : {}),
  });
}
services.ownerName = config.ownerDisplayName;
const videoSendsInFlight = new Set<string>();
setInterval(() => {
  sendRequestedVideos(services, videoSendsInFlight, new Date()).catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "video auto-send failed"));
}, 5000).unref();
if (media && runtime.complete) {
  const complete = runtime.complete.bind(runtime);
  const stt = voice.stt instanceof OpenAiCompatibleStt ? voice.stt : undefined;
  media.useFinder(
    new MomentFinder({
      complete,
      exec: defaultExec,
      model: config.claude.model,
      ...(stt ? { transcribe: (audio, signal) => stt.transcribeSegments(audio, signal) } : {}),
    }),
  );
}
const watcher = new WhatsAppWatcher({
  db,
  ownerName: config.ownerDisplayName,
  replyLimit: { replies: Number(process.env.WHATSAPP_REPLY_LIMIT ?? 5), minutes: Number(process.env.WHATSAPP_REPLY_WINDOW_MINUTES ?? 30) },
  attachments,
  speak: (text) => (services.voiceNotes ? services.voiceNotes.make(text) : Promise.reject(new Error("no voice"))),
  ...(runtime.complete && process.env.WHATSAPP_AUTO_REPLY !== "off"
    ? { reply: sarcasticReplier({ complete: runtime.complete.bind(runtime), model: config.claude.model, ownerName: config.ownerDisplayName }) }
    : {}),
});
const watchWhatsApp = () => {
  watcher.tick().catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "whatsapp watch failed"));
};
watchWhatsApp();
setInterval(watchWhatsApp, 4000).unref();
const bridgeMonitor = new BridgeMonitor(db);
setInterval(() => bridgeMonitor.check(), 60_000).unref();
/** The welcome sounds more robotic than calls, like the suit's JARVIS. */
const WELCOME_ROBOTIC_INTENSITY = 0.6;
const voiceNarrator = narratorFromEnv(process.env, join(config.dataDir, "voice-notes", "cache"));
const welcomeNarrator = narratorFromEnv({ ...process.env, VOICE_ROBOTIC_INTENSITY: String(WELCOME_ROBOTIC_INTENSITY) }, join(config.dataDir, "welcome", "voice"));
const welcome = new Welcome({ dir: join(config.dataDir, "welcome"), ownerName: config.ownerDisplayName, exec: defaultExec, ...(welcomeNarrator ? { narrator: welcomeNarrator } : {}) });
if (voiceNarrator) services.voiceNotes = new VoiceNoteMaker(voiceNarrator, defaultExec);
if (runtime.complete) {
  services.chatStudies = new ChatStudies({ db, runtime, outbox: new Outbox(db), ownerName: config.ownerDisplayName, timezone: config.timezone, model: config.claude.summaryModel, log: logger });
  services.chatStudies.resume();
}
services.analyzeFile = (file) => analyzeFile(file, { stt: voice.stt instanceof OpenAiCompatibleStt ? voice.stt : undefined });
if (tokenCipher) services.whatsappFiles = new WhatsAppFiles(db, tokenCipher, attachments, baileysDownload);
setInterval(() => fileLinks.purgeExpired(new Date()), 6 * 3_600_000).unref();
const sharedFile = (token: string) => {
  const attachmentId = fileLinks.resolve(token, new Date());
  const stored = attachmentId ? attachments.read(attachmentId) : undefined;
  return stored ? { name: stored.attachment.name, mediaType: stored.attachment.mediaType, data: stored.data } : undefined;
};
const pagesServer = pages && config.pages ? buildPagesServer(pages, { trustProxy: config.env === "production", sharedFile }) : undefined;

const store = new ConversationStore(db);
const hub = new ConversationHub();
const systemMessageFeed = new SystemMessageFeed(db, hub, logger, undefined, (conversationId, items) => orchestrator.noteSystemMessages(conversationId, items));

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
  sessionMaxContextTokens: config.claude.sessionMaxContextTokens,
  sessionIdleMs: config.claude.sessionIdleMs,
  textOnlySources,
  log: logger,
});
const devices = new DeviceStore(db);
const planUsage = config.claude.oauthToken ? new PlanUsageReader(config.claude.oauthToken) : undefined;

const app = await buildApp({
  config,
  logger,
  db,
  store,
  hub,
  assistantContext,
  registerRoutes: async (instance, helpers) => {
    await gmail.registerRoutes(instance, helpers);
    connections.registerRoutes(instance, helpers);
    if (planUsage) registerUsageRoutes(instance, helpers, planUsage);
    if (speaker) registerEnrollmentRoutes(instance, helpers, { dir: join(config.dataDir, "voice", "enrollment"), speaker });
    if (tasks && workLayout && config.tasks) registerTaskRoutes(instance, helpers, tasks, workLayout, config.tasks.maxAttachmentBytes);
    registerAttachmentRoutes(instance, helpers, attachments, voice.stt instanceof OpenAiCompatibleStt ? voice.stt : undefined);
    registerWelcomeRoutes(instance, helpers, { welcome, transfers, transfersDir });
    const transferRoutes = registerTransferRoutes(instance, helpers, {
      db,
      store: transfers,
      dir: transfersDir,
      publicOrigin: config.publicOrigin,
      ownerName: config.ownerDisplayName,
      freeBytes: () => readDiskUsage(config.dataDir).freeBytes,
      previews: transferPreviews,
      ...(media ? { media } : {}),
      ...(mediaChoices ? { choices: mediaChoices } : {}),
    });
    media?.resume();
    driveUploads?.start();
    setInterval(() => {
      transferRoutes.sweep().catch((error: unknown) => logger.warn({ err: error instanceof Error ? error.message : "unknown" }, "transfer sweep failed"));
    }, 15 * 60_000).unref();
    registerVideoRoutes(instance, helpers, videos, attachments, videosDir, (input) => sendVideo(services, input, new Date()));
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
  onTaskAction: tasks
    ? (action) => cardOutcome(tasks, tasks.decide(action.taskId, action.action, action.approvalId, new Date()))
    : undefined,
  refreshCard: (card) => {
    if (card.kind === "task") return tasks?.cardFor(card.taskId) ?? card;
    if (card.kind === "video") return videos.card(card.videoId, card.version) ?? card;
    if (card.kind === "confirm") return currentConfirmCard(db, card, new Date());
    if (card.kind === "media_choice" && mediaChoices) {
      const choice = mediaChoices.get(card.choiceId);
      return choice ? mediaChoices.card(choice) : card;
    }
    return card;
  },
  speaker,
  build: tasks
    ? {
        list: () => tasks.buildCards(),
        request: (text) => cardOutcome(tasks, tasks.createBuild(text, new Date())),
        feedback: (taskId, text) => cardOutcome(tasks, tasks.buildFeedback(taskId, text, new Date())),
      }
    : undefined,
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
  await media?.stop();
  await driveUploads?.stop();
  await app.close();
  await pagesServer?.close();
  db.close();
  workDb?.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const LOOP_SAMPLE_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
loopDelay.enable();
setInterval(() => {
  const lagMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e6) - LOOP_SAMPLE_MS);
  logger.info({ lagP50Ms: lagMs(loopDelay.percentile(50)), lagP99Ms: lagMs(loopDelay.percentile(99)), lagMaxMs: lagMs(loopDelay.max), rssMb: Math.round(process.memoryUsage().rss / 1048576) }, "event loop");
  loopDelay.reset();
}, 60_000).unref();

await app.listen({ host: config.host, port: config.port });
if (pagesServer && config.pages) await pagesServer.listen({ host: config.host, port: config.pages.port });
systemMessageFeed.start();
