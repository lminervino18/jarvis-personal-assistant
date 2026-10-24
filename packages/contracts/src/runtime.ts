import type { ReplyMode } from "./states.js";

/**
 * Contract between the conversation orchestrator and the model runtime. The runtime
 * implementation (Claude Agent SDK) can be swapped without touching transport or voice.
 */
export interface RuntimeTurnInput {
  conversationId: string;
  turnId: string;
  text: string;
  replyMode: ReplyMode;
  /** Claude session to resume. Undefined starts a new session. */
  resumeSessionId?: string;
  /** Extra context for a fresh session (recent history summary) when not resuming. */
  seedContext?: string;
  signal: AbortSignal;
}

export type RuntimeErrorCode =
  | "cancelled"
  | "quota_exceeded"
  | "auth_failed"
  | "resume_failed"
  | "unavailable"
  | "internal";

export type RuntimeEvent =
  | { type: "session"; sessionId: string; model: string; tools: string[]; mcpServers: string[]; authSource: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolUseId: string; name: string }
  | { type: "tool_end"; toolUseId: string; name: string; isError: boolean }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | {
      type: "result";
      sessionId: string;
      text: string;
      durationMs: number;
      numTurns: number;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    }
  | { type: "error"; code: RuntimeErrorCode; message: string; sessionId?: string; retryAfterMs?: number };

export interface ModelRuntime {
  readonly name: string;
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
}
