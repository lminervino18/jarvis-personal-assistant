import { writeFileSync } from "node:fs";
import { openMigratedDatabase } from "./db/database.js";
import { createLogger } from "./logger.js";
import { createWebPushSender } from "./push/sender.js";
import { loadWorkerConfig } from "./worker/config.js";
import { OutboxDispatcher } from "./worker/dispatcher.js";
import { ReminderScheduler } from "./worker/scheduler.js";

const config = loadWorkerConfig();
const logger = createLogger(config.logLevel);
const db = openMigratedDatabase(config.dbPath);
const scheduler = new ReminderScheduler(db, { graceMs: config.graceMinutes * 60_000 });
const dispatcher = new OutboxDispatcher({ db, log: logger, sender: config.vapid ? createWebPushSender(config.vapid) : undefined });

if (!config.vapid) logger.warn("VAPID keys are not configured; reminders reach the chat only");

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let cycle: Promise<void> = Promise.resolve();

async function runCycle(): Promise<void> {
  try {
    const now = new Date();
    const result = scheduler.tick(now);
    if (result.fired + result.missed > 0) logger.info(result, "reminders claimed");
    await dispatcher.runOnce(now);
    writeFileSync(process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/worker-heartbeat", String(Date.now()));
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : "unknown" }, "worker cycle failed");
  }
}

function schedule(): void {
  if (stopping) return;
  timer = setTimeout(() => {
    cycle = runCycle().then(schedule);
  }, config.pollMs);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, "worker shutting down");
  stopping = true;
  clearTimeout(timer);
  await cycle;
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info({ graceMinutes: config.graceMinutes, pollMs: config.pollMs }, "worker started");
cycle = runCycle().then(schedule);
