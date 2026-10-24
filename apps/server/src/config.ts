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
  CLAUDE_MODEL: z.string().optional(),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(12),
  CLAUDE_SESSION_MAX_TURNS: z.coerce.number().int().min(2).max(500).default(40),
  CLAUDE_ALLOW_OVERAGE: booleanFlag,
  FOLLOW_UP_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(12_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
    model?: string;
    configDir?: string;
    oauthToken?: string;
    maxTurns: number;
    sessionMaxTurns: number;
    allowOverage: boolean;
    workspaceDir: string;
  };
  followUpWindowMs: number;
  logLevel: string;
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
      sessionMaxTurns: parsed.CLAUDE_SESSION_MAX_TURNS,
      allowOverage: parsed.CLAUDE_ALLOW_OVERAGE,
      workspaceDir: resolve(dataDir, "runtime-workspace"),
    },
    followUpWindowMs: parsed.FOLLOW_UP_WINDOW_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
