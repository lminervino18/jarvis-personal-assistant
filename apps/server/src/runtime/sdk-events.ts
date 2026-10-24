import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeErrorCode, RuntimeEvent } from "@jarvis/contracts";

export interface MapperState {
  sessionId?: string;
  toolNames: Map<string, string>;
  text: string;
  allowOverage: boolean;
  now: () => number;
}

export function createMapperState(allowOverage: boolean, now: () => number = Date.now): MapperState {
  return { toolNames: new Map(), text: "", allowOverage, now };
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
          events.push({ type: "tool_end", toolUseId: block.tool_use_id, name, isError: block.is_error === true });
        }
      }
      return events;
    }
    case "assistant": {
      if (!message.error) return [];
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
