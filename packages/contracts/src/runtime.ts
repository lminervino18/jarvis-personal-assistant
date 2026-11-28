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
  /** Images and PDFs the owner attached to this message, base64-encoded. */
  files?: RuntimeFile[];
  signal: AbortSignal;
}

export interface RuntimeFile {
  mediaType: string;
  data: string;
}

export type RuntimeErrorCode =
  | "cancelled"
  | "quota_exceeded"
  | "auth_failed"
  | "resume_failed"
  | "unavailable"
  | "internal";

/** Token totals of a turn, plus the size of the context sent in its last model call. */
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
}

export type RuntimeEvent =
  | { type: "session"; sessionId: string; model: string; tools: string[]; mcpServers: string[]; authSource: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolUseId: string; name: string }
  | { type: "tool_run"; toolUseId: string; name: string }
  | { type: "tool_end"; toolUseId: string; name: string; isError: boolean; errorCode?: string }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | {
      type: "result";
      sessionId: string;
      text: string;
      durationMs: number;
      numTurns: number;
      usage: RuntimeUsage;
    }
  | { type: "error"; code: RuntimeErrorCode; message: string; sessionId?: string; retryAfterMs?: number };

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** Images or PDFs the model looks at, in order, before the prompt. */
  files?: RuntimeFile[];
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Lets the model search the web (a few searches) before answering; nothing else. */
  webSearch?: boolean;
}

export interface ModelRuntime {
  readonly name: string;
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  /** One-shot call without tools or session, used to summarize conversations. Rejects on failure. */
  summarize?(prompt: string, signal: AbortSignal): Promise<string>;
  /** One-shot text completion with its own system prompt, no tools and no session (used to write web pages). Rejects on failure. */
  complete?(request: CompletionRequest, signal: AbortSignal): Promise<string>;
  /**
   * Sends a throwaway request with exactly the prefix of a turn (system prompt and tools, from the
   * toolset registered for `turnId`), so the next real turn reads the prompt cache instead of writing it.
   */
  warm?(turnId: string, signal: AbortSignal): Promise<void>;
  /**
   * Starts the model process for a turn that is about to begin (the owner started speaking), so its
   * start-up overlaps the speech. A later runTurn with the same turn id and session uses it.
   */
  prepare?(turnId: string, resumeSessionId: string | undefined): void;
  /** Drops a prepared turn that will not run. */
  discard?(turnId: string): void;
}
