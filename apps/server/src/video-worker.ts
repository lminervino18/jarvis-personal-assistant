import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AttachmentStore } from "./attachments/attachment-store.js";
import { openMigratedDatabase } from "./db/database.js";
import { createLogger } from "./logger.js";
import { narratorFromEnv } from "./videos/narrator.js";
import { LEASE_MS, VideoPipeline } from "./videos/video-pipeline.js";
import { defaultExec } from "./videos/video-qa.js";
import { VideoStore } from "./videos/video-store.js";
import { OpenAiCompatibleStt } from "./voice/openai-stt.js";
import { createVoiceServices } from "./voice/providers.js";

const Env = z.object({
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  VIDEO_BUNDLE_DIR: z.string().default("/app/video-bundle"),
  VIDEO_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(3),
});

const env = Env.parse(process.env);
const logger = createLogger(env.LOG_LEVEL);
const dataDir = resolve(env.DATA_DIR);
const db = openMigratedDatabase(join(dataDir, "jarvis.db"));
const store = new VideoStore(db);
const heartbeat = process.env.VIDEO_HEARTBEAT_FILE ?? "/tmp/video-heartbeat";

const narrator = narratorFromEnv(process.env, join(dataDir, "videos", "cache", "tts"));
if (!narrator) logger.error("video worker needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID; videos stay queued");

const stt = createVoiceServices(process.env, { allowFixtures: false }).stt;
const pipeline = narrator
  ? new VideoPipeline({
      db,
      store,
      attachments: new AttachmentStore(db, join(dataDir, "attachments")),
      narrator,
      ...(stt instanceof OpenAiCompatibleStt ? { stt } : {}),
      exec: defaultExec,
      bundleDir: env.VIDEO_BUNDLE_DIR,
      videosDir: join(dataDir, "videos"),
      log: logger,
    })
  : undefined;

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let cycle: Promise<void> = Promise.resolve();

async function runCycle(): Promise<void> {
  try {
    writeFileSync(heartbeat, String(Date.now()));
    const version = pipeline ? store.claimNext(new Date(), LEASE_MS) : undefined;
    if (version && pipeline) {
      logger.info({ videoId: version.videoId, version: version.version, attempt: version.attempts }, "video started");
      const beat = setInterval(() => writeFileSync(heartbeat, String(Date.now())), 15_000);
      await pipeline.run(version).finally(() => clearInterval(beat));
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : "unknown" }, "video cycle failed");
  }
}

function schedule(): void {
  if (stopping) return;
  timer = setTimeout(() => {
    cycle = runCycle().then(schedule);
  }, env.VIDEO_POLL_SECONDS * 1000);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, "video worker shutting down");
  stopping = true;
  clearTimeout(timer);
  await cycle;
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ bundle: env.VIDEO_BUNDLE_DIR }, "video worker started");
cycle = runCycle().then(schedule);
