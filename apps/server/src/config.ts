import { resolve } from "node:path";
import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_ORIGIN: z.url().default("http://localhost:5173"),
  DATA_DIR: z.string().default("./data"),
  WEB_DIST_DIR: z.string().optional(),
  TIMEZONE: z.string().default("America/Argentina/Buenos_Aires"),
  OWNER_DISPLAY_NAME: z.string().default("Loren"),
  OWNER_PASSWORD_HASH: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RUNTIME: z.enum(["claude", "scripted"]).default("claude"),
  CLAUDE_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(12),
  CLAUDE_SUMMARY_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  CLAUDE_SESSION_MAX_TURNS: z.coerce.number().int().min(2).max(500).default(15),
  CLAUDE_SESSION_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(5_000).max(1_000_000).default(40_000),
  CLAUDE_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  CLAUDE_ALLOW_OVERAGE: booleanFlag,
  FOLLOW_UP_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(12_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WORK_DIR: z.string().optional().transform((value) => value || undefined),
  TASK_DEFAULT_BUDGET_USD: z.coerce.number().positive().max(100).default(5),
  TASK_MAX_ATTACHMENT_MB: z.coerce.number().positive().max(50).default(10),
  PUBLISH_DIR: z.string().optional().transform((value) => value || undefined),
  PUBLISH_SIGNING_KEY: z.string().optional().transform((value) => value || undefined),
  PAGES_BASE_URL: z.string().optional().transform((value) => value || undefined).pipe(z.url().optional()),
  PAGES_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  PAGES_MODEL: z.string().optional().transform((value) => value || undefined),
});

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  publicOrigin: string;
  dataDir: string;
  dbPath: string;
  webDistDir?: string;
  timezone: string;
  ownerDisplayName: string;
  ownerPasswordHash?: string;
  sessionTtlDays: number;
  runtime: "claude" | "scripted";
  claude: {
    model: string;
    configDir?: string;
    oauthToken?: string;
    maxTurns: number;
    summaryModel: string;
    sessionMaxTurns: number;
    sessionMaxContextTokens: number;
    sessionIdleMs: number;
    allowOverage: boolean;
    workspaceDir: string;
  };
  followUpWindowMs: number;
  logLevel: string;
  /** Generated web pages are enabled when their public base URL is configured. */
  pages?: { baseUrl: string; port: number; model?: string };
  /** Delegated tasks are enabled when the work volume is configured. */
  tasks?: { workDir: string; defaultBudgetUsd: number; maxAttachmentBytes: number; publish?: { dir: string; signingKey: string } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const dataDir = resolve(parsed.DATA_DIR);
  if (parsed.NODE_ENV === "production" && !parsed.OWNER_PASSWORD_HASH) {
    throw new Error("OWNER_PASSWORD_HASH is required in production");
  }
  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    publicOrigin: new URL(parsed.PUBLIC_ORIGIN).origin,
    dataDir,
    dbPath: resolve(dataDir, "jarvis.db"),
    webDistDir: parsed.WEB_DIST_DIR ? resolve(parsed.WEB_DIST_DIR) : undefined,
    timezone: parsed.TIMEZONE,
    ownerDisplayName: parsed.OWNER_DISPLAY_NAME,
    ownerPasswordHash: parsed.OWNER_PASSWORD_HASH,
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    runtime: parsed.RUNTIME,
    claude: {
      model: parsed.CLAUDE_MODEL,
      configDir: parsed.CLAUDE_CONFIG_DIR ? resolve(parsed.CLAUDE_CONFIG_DIR) : undefined,
      oauthToken: parsed.CLAUDE_CODE_OAUTH_TOKEN,
      maxTurns: parsed.CLAUDE_MAX_TURNS,
      summaryModel: parsed.CLAUDE_SUMMARY_MODEL,
      sessionMaxTurns: parsed.CLAUDE_SESSION_MAX_TURNS,
      sessionMaxContextTokens: parsed.CLAUDE_SESSION_MAX_CONTEXT_TOKENS,
      sessionIdleMs: parsed.CLAUDE_SESSION_IDLE_MINUTES * 60_000,
      allowOverage: parsed.CLAUDE_ALLOW_OVERAGE,
      workspaceDir: resolve(dataDir, "runtime-workspace"),
    },
    followUpWindowMs: parsed.FOLLOW_UP_WINDOW_MS,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.PAGES_BASE_URL ? { pages: { baseUrl: parsed.PAGES_BASE_URL, port: parsed.PAGES_PORT, model: parsed.PAGES_MODEL } } : {}),
    tasks: parsed.WORK_DIR
      ? {
          workDir: resolve(parsed.WORK_DIR),
          defaultBudgetUsd: parsed.TASK_DEFAULT_BUDGET_USD,
          maxAttachmentBytes: Math.round(parsed.TASK_MAX_ATTACHMENT_MB * 1024 * 1024),
          ...(parsed.PUBLISH_DIR && parsed.PUBLISH_SIGNING_KEY ? { publish: { dir: resolve(parsed.PUBLISH_DIR), signingKey: parsed.PUBLISH_SIGNING_KEY } } : {}),
        }
      : undefined,
  };
}
