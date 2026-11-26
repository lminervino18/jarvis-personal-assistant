import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeErrorCode, RuntimeEvent } from "@jarvis/contracts";

export interface MapperState {
  sessionId?: string;
  toolNames: Map<string, string>;
  text: string;
  allowOverage: boolean;
  contextTokens: number;
  now: () => number;
}

export function createMapperState(allowOverage: boolean, now: () => number = Date.now): MapperState {
  return { toolNames: new Map(), text: "", allowOverage, contextTokens: 0, now };
}

const assistantErrorCodes: Record<string, RuntimeErrorCode> = {
  authentication_failed: "auth_failed",
  oauth_org_not_allowed: "auth_failed",
  account_on_hold: "auth_failed",
  verification_required: "auth_failed",
  billing_error: "quota_exceeded",
  rate_limit: "quota_exceeded",
  overloaded: "unavailable",
  server_error: "unavailable",
};

interface CallUsage {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function contextTokensOf(usage: CallUsage | undefined): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
}

const FAILURE_CODE = /^\{"ok":false,"error":\{"code":"([a-z_]{1,40})"/;

/** The error code of one of our tools' failure envelopes, read from the start of its result only. */
function failureCode(content: unknown): string | undefined {
  const first = typeof content === "string" ? content : Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  return typeof first === "string" ? FAILURE_CODE.exec(first.slice(0, 80))?.[1] : undefined;
}

/** A complete tool call in an assistant message is the moment the call goes out to execution. */
function toolRuns(content: unknown): RuntimeEvent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: string; id?: string; name?: string }) =>
    (block.type === "tool_use" || block.type === "server_tool_use") && block.id && block.name
      ? [{ type: "tool_run" as const, toolUseId: block.id, name: block.name }]
      : [],
  );
}

const RESUME_FAILURE = /no conversation found|session .*not found|could not (find|load) session/i;

/**
 * Translates one Agent SDK message into runtime events. Only the main conversation
 * thread produces text; tool payloads and internal reasoning are never surfaced.
 */
export function mapSdkMessage(message: SDKMessage, state: MapperState): RuntimeEvent[] {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        state.sessionId = message.session_id;
        return [
          {
            type: "session",
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            mcpServers: message.mcp_servers.map((server) => `${server.name}:${server.status}`),
            authSource: message.apiKeySource,
          },
        ];
      }
      if (message.subtype === "api_retry") {
        return [
          {
            type: "retry",
            attempt: message.attempt,
            maxRetries: message.max_retries,
            delayMs: message.retry_delay_ms,
            reason: message.error,
          },
        ];
      }
      return [];
    }
    case "stream_event": {
      if (message.parent_tool_use_id !== null) return [];
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        state.text += event.delta.text;
        return [{ type: "text_delta", text: event.delta.text }];
      }
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          state.toolNames.set(block.id, block.name);
          return [{ type: "tool_start", toolUseId: block.id, name: block.name }];
        }
        if (block.type === "web_search_tool_result") {
          const name = state.toolNames.get(block.tool_use_id) ?? "web_search";
          return [{ type: "tool_end", toolUseId: block.tool_use_id, name, isError: false }];
        }
        if (block.type === "text" && state.text.length > 0 && !/\s$/.test(state.text)) {
          state.text += "\n\n";
          return [{ type: "text_delta", text: "\n\n" }];
        }
      }
      return [];
    }
    case "user": {
      if (message.parent_tool_use_id !== null) return [];
      const content = message.message.content;
      if (typeof content === "string") return [];
      const events: RuntimeEvent[] = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const name = state.toolNames.get(block.tool_use_id) ?? "unknown";
          const errorCode = failureCode(block.content);
          events.push({ type: "tool_end", toolUseId: block.tool_use_id, name, isError: block.is_error === true, ...(errorCode ? { errorCode } : {}) });
        }
      }
      return events;
    }
    case "assistant": {
      if (message.parent_tool_use_id === null) state.contextTokens = contextTokensOf(message.message.usage);
      if (!message.error) return message.parent_tool_use_id === null ? toolRuns(message.message.content) : [];
      const code = assistantErrorCodes[message.error] ?? "internal";
      return [{ type: "error", code, message: `Claude error: ${message.error}`, sessionId: message.session_id }];
    }
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      const retryAfterMs = info.resetsAt ? Math.max(0, info.resetsAt * 1000 - state.now()) : undefined;
      if (info.status === "rejected") {
        return [{ type: "error", code: "quota_exceeded", message: "Subscription usage limit reached", retryAfterMs }];
      }
      if ((info.isUsingOverage || info.overageInUse) && !state.allowOverage) {
        return [{ type: "error", code: "quota_exceeded", message: "Paid overage is disabled for this assistant", retryAfterMs }];
      }
      return [];
    }
    case "result": {
      if (message.subtype === "success") {
        return [
          {
            type: "result",
            sessionId: message.session_id,
            text: state.text || message.result,
            durationMs: message.duration_ms,
            numTurns: message.num_turns,
            usage: {
              inputTokens: message.usage.input_tokens,
              outputTokens: message.usage.output_tokens,
              cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
              contextTokens: state.contextTokens,
            },
          },
        ];
      }
      const detail = message.errors.join("; ");
      const code: RuntimeErrorCode = RESUME_FAILURE.test(detail) ? "resume_failed" : "internal";
      return [{ type: "error", code, message: `${message.subtype}: ${detail}`.slice(0, 500), sessionId: message.session_id }];
    }
    default:
      return [];
  }
}
