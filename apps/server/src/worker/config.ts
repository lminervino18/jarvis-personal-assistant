import { resolve } from "node:path";
import { z } from "zod";
import { loadVapidConfig, type VapidConfig } from "../push/vapid.js";
import { DEFAULT_GRACE_MINUTES } from "./scheduler.js";

const WorkerEnv = z.object({
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  REMINDER_GRACE_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(DEFAULT_GRACE_MINUTES),
  WORKER_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
});

export interface WorkerConfig {
  dbPath: string;
  logLevel: string;
  graceMinutes: number;
  pollMs: number;
  vapid?: VapidConfig;
}

/** The worker reads only what it needs, so it starts without the owner password or any Claude credentials. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = WorkerEnv.parse(env);
  return {
    dbPath: resolve(parsed.DATA_DIR, "jarvis.db"),
    logLevel: parsed.LOG_LEVEL,
    graceMinutes: parsed.REMINDER_GRACE_MINUTES,
    pollMs: parsed.WORKER_POLL_SECONDS * 1000,
    vapid: loadVapidConfig(env),
  };
}
