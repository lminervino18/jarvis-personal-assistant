import { query, type Options, type SDKMessage, type SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "../runtime/claude-runtime.js";
import { createAgentPolicyHook, OUTPUT_TOOL } from "./agent-policy.js";
import type { AgentBackend, AgentErrorCode, AgentRole, AgentRunRequest, AgentRunResult } from "./agent-backend.js";
import { jsonSchemaOf } from "./schemas.js";

export interface ClaudeAgentConfig {
  models: Record<AgentRole, string>;
  subagentModel: string;
  effort: Record<AgentRole, Effort>;
  maxTurns: Record<AgentRole, number>;
  timeoutMs: number;
  /** Model families agents may use, e.g. ["sonnet", "haiku"]. Anything else stops the task. */
  allowedFamilies: readonly string[];
  allowedDomains: readonly string[];
  /** Without a working sandbox, agents can still run with file tools only. */
  bash: boolean;
  sandboxRequired: boolean;
  weakerNestedSandbox: boolean;
  configDir?: string;
  /** Long-lived subscription token from `claude setup-token`. Without it, the local Claude Code login is used. */
  oauthToken?: string;
  baseEnv?: NodeJS.ProcessEnv;
  onDenied?(role: AgentRole, tool: string, reason: string): void;
  onStderr?(line: string): void;
}

const ROLE_TOOLS: Record<AgentRole, string[]> = {
  planner: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  executor: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent", "TodoWrite", "WebSearch", "WebFetch"],
  reviewer: ["Read", "Glob", "Grep", "Bash", "TodoWrite"],
};

const INHERITED_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];

const ERROR_CODES: Record<string, AgentErrorCode> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  billing_error: "usage_limit",
  rate_limit: "usage_limit",
  overloaded: "unavailable",
  server_error: "unavailable",
};

type PlanUsage = NonNullable<AgentRunResult["plan"]>;
type PlanWindows = Record<string, { utilization?: unknown; resetsAt?: unknown } | null>;

/**
 * The most used plan window in a rate-limit event. Uses the documented fields and, when the
 * CLI sends it, the per-window detail (`unifiedWindows`, not part of the public types), so
 * losing that detail in a future release only falls back to the documented warning levels.
 */
export function planUsage(info: SDKRateLimitInfo): PlanUsage | undefined {
  const toMs = (seconds: unknown) => (typeof seconds === "number" ? seconds * 1000 : undefined);
  const candidates: PlanUsage[] = [];
  const documented = info.utilization ?? info.surpassedThreshold;
  if (documented !== undefined) candidates.push({ utilization: Math.max(documented, info.surpassedThreshold ?? 0), resetsAt: toMs(info.resetsAt) });
  const windows = (info as { unifiedWindows?: PlanWindows }).unifiedWindows ?? {};
  for (const window of Object.values(windows)) {
    if (typeof window?.utilization === "number") candidates.push({ utilization: window.utilization, resetsAt: toMs(window.resetsAt) });
  }
  return candidates.reduce<PlanUsage | undefined>((best, candidate) => (!best || candidate.utilization > best.utilization ? candidate : best), undefined);
}

const INTERRUPT_GRACE_MS = 10_000;

type StopReason = "timeout" | "cancelled" | "plan_reserve";

const STOP_ERRORS: Record<StopReason, { code: AgentErrorCode; message: string }> = {
  timeout: { code: "timeout", message: "La sesión superó el tiempo máximo" },
  cancelled: { code: "cancelled", message: "Sesión cancelada" },
  plan_reserve: { code: "plan_reserve", message: "El plan llegó a la reserva para el chat" },
};

const EXPLORER_PROMPT =
  "Explorás código y archivos en modo solo lectura y devolvés un resumen preciso con rutas y líneas. No modificás nada y no inventás contenido.";

/**
 * Agent backend on the Claude Agent SDK. Every role runs with an explicit model, a fixed
 * tool list, a path policy for file tools and the Bash sandbox; nothing inherits defaults
 * from the machine's Claude Code settings.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly name = "claude-agent-sdk";
  readonly runsCommands: boolean;

  constructor(private readonly config: ClaudeAgentConfig) {
    this.runsCommands = config.bash;
    for (const model of [...Object.values(config.models), config.subagentModel]) {
      if (!this.isAllowedModel(model)) throw new Error(`model ${model} is not allowed for agents`);
    }
  }

  isAllowedModel(model: string): boolean {
    const lower = model.toLowerCase();
    return this.config.allowedFamilies.some((family) => lower === family || lower.includes(`-${family}-`) || lower.startsWith(`${family}-`));
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const controller = new AbortController();
    const result: AgentRunResult = { costUsd: 0, turns: 0, models: [] };
    const stream = query({ prompt: request.prompt, options: this.options(request, controller) });
    let stopReason: StopReason | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: StopReason) => {
      if (stopReason) return;
      stopReason = reason;
      stream.interrupt().catch(() => controller.abort());
      killTimer = setTimeout(() => controller.abort(), INTERRUPT_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timeout"), this.config.timeoutMs);
    const cancel = () => stop("cancelled");
    if (request.signal.aborted) cancel();
    request.signal.addEventListener("abort", cancel, { once: true });

    try {
      for await (const message of stream) {
        this.absorb(message, result);
        if (result.error?.code === "usage_limit") break;
        if (result.plan && result.plan.utilization >= request.planLimit) stop("plan_reserve");
      }
    } catch (error) {
      if (!result.error && !stopReason) {
        const detail = error instanceof Error ? error.message : String(error);
        result.error = { code: /no conversation found/i.test(detail) ? "resume_failed" : "unavailable", message: detail.slice(0, 300) };
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      request.signal.removeEventListener("abort", cancel);
      stream.close();
    }
    if (stopReason && result.output === undefined) result.error = STOP_ERRORS[stopReason];
    const forbidden = result.models.filter((model) => !this.isAllowedModel(model));
    if (forbidden.length > 0) result.error = { code: "model_policy", message: `Se usó un modelo no permitido: ${forbidden.join(", ")}` };
    return result;
  }

  private options(request: AgentRunRequest, controller: AbortController): Options {
    const { config } = this;
    const { role, dirs } = request;
    const tools = ROLE_TOOLS[role].filter((tool) => config.bash || tool !== "Bash");
    const writable = role === "executor" ? [dirs.cwd] : role === "reviewer" ? [dirs.cwd] : [];
    const readable = [dirs.cwd, ...dirs.readable];
    const hook = createAgentPolicyHook(
      {
        cwd: dirs.cwd,
        allowedTools: new Set(tools),
        readRoots: readable,
        writeRoots: role === "executor" ? [dirs.cwd] : [],
        forbiddenRoot: dirs.forbiddenRoot,
        subagents: new Set(role === "executor" ? ["explorer"] : []),
        isAllowedModel: (model) => this.isAllowedModel(model),
      },
      (tool, reason) => config.onDenied?.(role, tool, reason),
    );
    return {
      abortController: controller,
      cwd: dirs.cwd,
      additionalDirectories: dirs.readable,
      env: this.env(),
      model: config.models[role],
      effort: config.effort[role],
      maxTurns: config.maxTurns[role],
      maxBudgetUsd: request.maxBudgetUsd,
      resume: request.resumeSessionId,
      persistSession: role !== "reviewer",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],
      settings: { disableClaudeAiConnectors: true, availableModels: [...config.allowedFamilies] },
      strictMcpConfig: true,
      mcpServers: {},
      tools,
      allowedTools: [...tools, OUTPUT_TOOL],
      permissionMode: "dontAsk",
      agents:
        role === "executor"
          ? { explorer: { description: "Exploración de solo lectura del repositorio", prompt: EXPLORER_PROMPT, tools: ["Read", "Glob", "Grep"], model: config.subagentModel, maxTurns: 15 } }
          : undefined,
      sandbox: {
        enabled: true,
        failIfUnavailable: config.sandboxRequired,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        enableWeakerNestedSandbox: config.weakerNestedSandbox,
        network: { allowedDomains: [...config.allowedDomains] },
        filesystem: { allowWrite: writable, denyRead: [dirs.forbiddenRoot], allowRead: readable },
      },
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      outputFormat: { type: "json_schema", schema: jsonSchemaOf(request.outputSchema) },
      stderr: config.onStderr,
    };
  }

  private env(): Record<string, string> {
    const { config } = this;
    const base = config.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = base[key];
      if (value) env[key] = value;
    }
    env.DISABLE_AUTOUPDATER = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
    env.CLAUDE_CODE_SUBAGENT_MODEL = config.subagentModel;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "jarvis-agent-runner/0.1.0";
    if (config.configDir) env.CLAUDE_CONFIG_DIR = config.configDir;
    if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
    return env;
  }

  private absorb(message: SDKMessage, result: AgentRunResult): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          result.sessionId = message.session_id;
          if (!result.models.includes(message.model)) result.models.push(message.model);
        }
        return;
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        const plan = planUsage(info);
        if (plan && plan.utilization >= (result.plan?.utilization ?? 0)) result.plan = plan;
        if (info.status === "rejected" || info.isUsingOverage || info.overageInUse) {
          const retryAfterMs = info.resetsAt ? Math.max(0, info.resetsAt * 1000 - Date.now()) : undefined;
          result.error = { code: "usage_limit", message: "Se alcanzó el límite de uso o empezó a consumir excedente", retryAfterMs };
        }
        return;
      }
      case "assistant":
        if (message.error) result.error ??= { code: ERROR_CODES[message.error] ?? "internal", message: `Claude: ${message.error}` };
        return;
      case "result": {
        result.sessionId = message.session_id;
        result.costUsd = message.total_cost_usd;
        result.turns = message.num_turns;
        for (const model of Object.keys(message.modelUsage)) if (!result.models.includes(model)) result.models.push(model);
        if (message.subtype === "success") {
          if (message.structured_output === undefined) result.error ??= { code: "invalid_output", message: "La sesión no devolvió el informe estructurado" };
          else result.output = message.structured_output;
          return;
        }
        const detail = message.errors.join("; ").slice(0, 300);
        const code: AgentErrorCode =
          message.subtype === "error_max_budget_usd"
            ? "budget"
            : message.subtype === "error_max_turns"
              ? "max_turns"
              : message.subtype === "error_max_structured_output_retries"
                ? "invalid_output"
                : /no conversation found/i.test(detail)
                  ? "resume_failed"
                  : "internal";
        result.error ??= { code, message: `${message.subtype}: ${detail}` };
        return;
      }
      default:
        return;
    }
  }
}
