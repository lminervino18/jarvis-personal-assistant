import { resolve } from "node:path";
import { z } from "zod";
import type { Effort } from "../runtime/claude-runtime.js";
import type { AgentRole } from "./agent-backend.js";
import type { ClaudeAgentConfig } from "./claude-agent-backend.js";
import { defaultRunnerLimits, type TaskRunnerLimits } from "./task-runner.js";

/** Agents may only run on these model families; Opus and Fable are rejected at startup. */
export const AGENT_MODEL_FAMILIES = ["sonnet", "haiku"] as const;

const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((value) => value === "true" || value === "1");
const EffortValue = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** Hosts that agent commands may reach by default: package registries and GitHub. Web research goes through WebSearch and WebFetch. */
export const DEFAULT_AGENT_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "*.yarnpkg.com",
  "jsr.io",
  "*.jsr.io",
  "pypi.org",
  "*.pythonhosted.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
];

const ModelName = z.string().regex(/^(claude-)?(sonnet|haiku)[a-z0-9.-]*$/i, "agents only run on Sonnet or Haiku models");

const RunnerEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WORK_DIR: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TIMEZONE: z.string().default("America/Argentina/Buenos_Aires"),
  AGENT_CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  AGENT_CLAUDE_CONFIG_DIR: z.string().optional(),
  AGENT_MODEL_PLANNER: ModelName.default("claude-sonnet-5-5"),
  AGENT_MODEL_EXECUTOR: ModelName.default("claude-sonnet-5-5"),
  AGENT_MODEL_REVIEWER: ModelName.default("claude-sonnet-5-5"),
  AGENT_MODEL_SUBAGENT: ModelName.default("claude-haiku-5-5"),
  AGENT_EFFORT_PLANNER: EffortValue.default("medium"),
  AGENT_EFFORT_EXECUTOR: EffortValue.default("medium"),
  AGENT_EFFORT_REVIEWER: EffortValue.default("medium"),
  AGENT_MAX_TURNS_PLANNER: z.coerce.number().int().min(1).max(100).default(20),
  AGENT_MAX_TURNS_EXECUTOR: z.coerce.number().int().min(1).max(300).default(80),
  AGENT_MAX_TURNS_REVIEWER: z.coerce.number().int().min(1).max(200).default(40),
  AGENT_RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  AGENT_RUN_BUDGET_USD: z.coerce.number().positive().max(50).default(defaultRunnerLimits.runBudgetUsd),
  AGENT_MAX_FIX_ROUNDS: z.coerce.number().int().min(0).max(5).default(defaultRunnerLimits.maxFixRounds),
  AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(defaultRunnerLimits.maxAttempts),
  AGENT_PLAN_MAX_UTILIZATION: z.coerce.number().min(0.1).max(1).default(defaultRunnerLimits.planMaxUtilization),
  AGENT_ALLOWED_DOMAINS: z.string().default(DEFAULT_AGENT_DOMAINS.join(",")),
  AGENT_BASH: flag("true"),
  AGENT_SANDBOX_REQUIRED: z.string().optional(),
  AGENT_SANDBOX_WEAKER_NESTED: flag("false"),
  AGENT_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(3),
});

export interface RunnerConfig {
  workDir: string;
  logLevel: string;
  timezone: string;
  limits: TaskRunnerLimits;
  agent: Omit<ClaudeAgentConfig, "onDenied" | "onStderr" | "baseEnv">;
}

/**
 * The runner reads only agent settings: no owner password, no personal tokens, no personal database.
 * Agents run on the owner's subscription; an API key is never read or forwarded.
 */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = RunnerEnv.parse(env);
  const production = parsed.NODE_ENV === "production";
  const oauthToken = parsed.AGENT_CLAUDE_CODE_OAUTH_TOKEN || undefined;
  if (production && !oauthToken) throw new Error("AGENT_CLAUDE_CODE_OAUTH_TOKEN is required in production (claude setup-token)");
  const workDir = resolve(parsed.WORK_DIR);
  const sandboxRequired = parsed.AGENT_SANDBOX_REQUIRED === undefined ? production : flag("false").parse(parsed.AGENT_SANDBOX_REQUIRED);
  const roles = <T>(planner: T, executor: T, reviewer: T): Record<AgentRole, T> => ({ planner, executor, reviewer });
  return {
    workDir,
    logLevel: parsed.LOG_LEVEL,
    timezone: parsed.TIMEZONE,
    limits: {
      ...defaultRunnerLimits,
      concurrency: parsed.AGENT_CONCURRENCY,
      runBudgetUsd: parsed.AGENT_RUN_BUDGET_USD,
      maxFixRounds: parsed.AGENT_MAX_FIX_ROUNDS,
      maxAttempts: parsed.AGENT_MAX_ATTEMPTS,
      planMaxUtilization: parsed.AGENT_PLAN_MAX_UTILIZATION,
      pollMs: parsed.AGENT_POLL_SECONDS * 1000,
    },
    agent: {
      models: roles(parsed.AGENT_MODEL_PLANNER, parsed.AGENT_MODEL_EXECUTOR, parsed.AGENT_MODEL_REVIEWER),
      subagentModel: parsed.AGENT_MODEL_SUBAGENT,
      effort: roles<Effort>(parsed.AGENT_EFFORT_PLANNER, parsed.AGENT_EFFORT_EXECUTOR, parsed.AGENT_EFFORT_REVIEWER),
      maxTurns: roles(parsed.AGENT_MAX_TURNS_PLANNER, parsed.AGENT_MAX_TURNS_EXECUTOR, parsed.AGENT_MAX_TURNS_REVIEWER),
      timeoutMs: parsed.AGENT_RUN_TIMEOUT_MINUTES * 60_000,
      allowedFamilies: AGENT_MODEL_FAMILIES,
      allowedDomains: parsed.AGENT_ALLOWED_DOMAINS.split(",").map((domain) => domain.trim()).filter(Boolean),
      bash: parsed.AGENT_BASH,
      sandboxRequired,
      weakerNestedSandbox: parsed.AGENT_SANDBOX_WEAKER_NESTED,
      oauthToken,
      configDir: parsed.AGENT_CLAUDE_CONFIG_DIR ? resolve(parsed.AGENT_CLAUDE_CONFIG_DIR) : oauthToken ? resolve(workDir, "claude") : undefined,
    },
  };
}
