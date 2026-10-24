import { mkdirSync } from "node:fs";
import { query, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ModelRuntime, RuntimeEvent, RuntimeTurnInput } from "@jarvis/contracts";
import type { TurnSecurityState } from "../tools/types.js";
import { temporalContext } from "../util/time.js";
import { buildRuntimeEnv } from "./runtime-env.js";
import { createMapperState, mapSdkMessage } from "./sdk-events.js";
import { createToolPolicyHook } from "./tool-policy.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface TurnToolset {
  server: McpSdkServerConfigWithInstance;
  /** Fully qualified tool names (mcp__jarvis__x plus allowed built-ins). */
  allowedTools: string[];
  security: TurnSecurityState;
}

export interface ClaudeRuntimeOptions {
  workspaceDir: string;
  timezone: string;
  model?: string;
  effort?: Effort;
  maxTurns: number;
  allowOverage: boolean;
  configDir?: string;
  oauthToken?: string;
  baseEnv?: NodeJS.ProcessEnv;
  systemPrompt(): string;
  toolsetFor(input: RuntimeTurnInput): TurnToolset;
  now?: () => Date;
  onDeniedTool?: (name: string) => void;
  onStderr?: (line: string) => void;
}

/** Built-in Claude Code tools that must never be available, even if defaults change. */
const FORBIDDEN_BUILTINS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
];

/** Stops iterating as soon as the signal aborts, without waiting for the next message. */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<IteratorReturnResult<undefined>>((resolve) => {
    if (signal.aborted) resolve({ done: true, value: undefined });
    signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
  });
  while (true) {
    const next = await Promise.race([iterator.next(), aborted]);
    if (next.done) return;
    yield next.value;
  }
}

export function composeTurnPrompt(input: RuntimeTurnInput, now: Date, timezone: string): string {
  const channel = input.replyMode === "voice" ? "voz" : "texto";
  const header = `[contexto: ${temporalContext(now, timezone)} · canal: ${channel}]`;
  const seed = input.seedContext
    ? `\n\n[historial reciente recuperado de la base, para continuidad; no es un pedido nuevo]\n${input.seedContext}\n[fin del historial]`
    : "";
  return `${header}${seed}\n\n${input.text}`;
}

/**
 * Model runtime backed by the official Claude Agent SDK, authenticated with the owner's
 * Claude subscription. Each turn resumes an explicit session id; there is no global
 * "continue" and no tool beyond the per-turn allowlist.
 */
export class ClaudeAgentRuntime implements ModelRuntime {
  readonly name = "claude-agent-sdk";

  constructor(private readonly options: ClaudeRuntimeOptions) {
    mkdirSync(options.workspaceDir, { recursive: true });
  }

  async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const options = this.options;
    const now = options.now?.() ?? new Date();
    const toolset = options.toolsetFor(input);
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (input.signal.aborted) abort();
    input.signal.addEventListener("abort", abort, { once: true });

    const state = createMapperState(options.allowOverage);
    const allowed = new Set(toolset.allowedTools);
    const stream = query({
      prompt: composeTurnPrompt(input, now, options.timezone),
      options: {
        abortController,
        cwd: options.workspaceDir,
        env: buildRuntimeEnv(options.baseEnv ?? process.env, {
          timezone: options.timezone,
          configDir: options.configDir,
          oauthToken: options.oauthToken,
        }),
        resume: input.resumeSessionId,
        includePartialMessages: true,
        systemPrompt: { type: "custom", prompt: options.systemPrompt(), snapshot: false },
        settingSources: [],
        settings: { disableClaudeAiConnectors: true },
        strictMcpConfig: true,
        mcpServers: { jarvis: toolset.server },
        tools: toolset.allowedTools.filter((name) => !name.startsWith("mcp__")),
        allowedTools: toolset.allowedTools,
        disallowedTools: FORBIDDEN_BUILTINS,
        permissionMode: "dontAsk",
        hooks: {
          PreToolUse: [{ hooks: [createToolPolicyHook(allowed, toolset.security, options.onDeniedTool)] }],
        },
        model: options.model,
        effort: options.effort,
        maxTurns: options.maxTurns,
        persistSession: true,
        stderr: options.onStderr,
      },
    });

    let finished = false;
    try {
      for await (const message of untilAborted(stream, input.signal)) {
        for (const event of mapSdkMessage(message, state)) {
          yield event;
          if (event.type === "error") {
            finished = true;
            abortController.abort();
            return;
          }
          if (event.type === "result") finished = true;
        }
      }
      if (!finished) {
        yield input.signal.aborted
          ? { type: "error", code: "cancelled", message: "Turn cancelled", sessionId: state.sessionId }
          : { type: "error", code: "internal", message: "Runtime ended without a result", sessionId: state.sessionId };
      }
    } catch (error) {
      if (input.signal.aborted) {
        yield { type: "error", code: "cancelled", message: "Turn cancelled", sessionId: state.sessionId };
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const code = /no conversation found/i.test(detail) ? "resume_failed" : "unavailable";
      yield { type: "error", code, message: detail.slice(0, 500), sessionId: state.sessionId };
    } finally {
      input.signal.removeEventListener("abort", abort);
      stream.close();
    }
  }
}
