import type { z } from "zod";

export type AgentRole = "planner" | "executor" | "reviewer";

export type AgentErrorCode =
  | "budget"
  | "max_turns"
  | "usage_limit"
  | "auth"
  | "unavailable"
  | "cancelled"
  | "plan_reserve"
  | "timeout"
  | "invalid_output"
  | "model_policy"
  | "resume_failed"
  | "internal";

export interface AgentDirs {
  /** Working directory. The executor may write here; the other roles may not. */
  cwd: string;
  /** Extra directories the agent may read but never write. */
  readable: string[];
  /** Root that holds every task; anything under it outside `cwd` and `readable` is off limits. */
  forbiddenRoot: string;
}

export interface AgentRunRequest {
  role: AgentRole;
  taskId: string;
  prompt: string;
  dirs: AgentDirs;
  outputSchema: z.ZodType;
  resumeSessionId?: string;
  maxBudgetUsd: number;
  /** Plan utilization (0 to 1) at which the session stops so the rest of the window stays for the chat. */
  planLimit: number;
  signal: AbortSignal;
}

export interface AgentRunResult {
  output?: unknown;
  sessionId?: string;
  costUsd: number;
  turns: number;
  models: string[];
  /** Highest plan usage reported during the session, as a fraction of the window, and when that window resets (epoch ms). Only subscription logins report it. */
  plan?: { utilization: number; resetsAt?: number };
  error?: { code: AgentErrorCode; message: string; retryAfterMs?: number };
}

/**
 * Runs one agent session for one phase of a task. Implementations own the model, tools
 * and sandbox; the runner owns state, limits and retries.
 */
export interface AgentBackend {
  readonly name: string;
  /** Whether agents can execute commands (tests, builds) in this deployment. */
  readonly runsCommands: boolean;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export const retryableAgentErrors: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>(["unavailable", "timeout", "internal", "resume_failed"]);
