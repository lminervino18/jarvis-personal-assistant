import { randomUUID } from "node:crypto";
import type { ModelRuntime, RuntimeEvent, RuntimeTurnInput } from "@jarvis/contracts";

export interface ScriptedReply {
  text?: string;
  error?: Extract<RuntimeEvent, { type: "error" }>;
  chunkDelayMs?: number;
}

/**
 * Deterministic runtime for tests and offline development. It never contacts Claude
 * and is clearly labeled as a fixture in the session event.
 */
export class ScriptedRuntime implements ModelRuntime {
  readonly name = "scripted";
  readonly calls: RuntimeTurnInput[] = [];
  private readonly sessions = new Set<string>();

  constructor(private readonly reply: (input: RuntimeTurnInput) => ScriptedReply = (input) => ({ text: `Recibido: ${input.text}` })) {}

  async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.calls.push(input);
    if (input.resumeSessionId && !this.sessions.has(input.resumeSessionId)) {
      yield { type: "error", code: "resume_failed", message: "No conversation found with session ID" };
      return;
    }
    const sessionId = input.resumeSessionId ?? randomUUID();
    this.sessions.add(sessionId);
    yield { type: "session", sessionId, model: "scripted-fixture", tools: [], mcpServers: [], authSource: "fixture" };

    const reply = this.reply(input);
    if (reply.error) {
      yield { ...reply.error, sessionId };
      return;
    }
    const words = (reply.text ?? "").split(/(?<=\s)/);
    let text = "";
    for (const word of words) {
      if (input.signal.aborted) {
        yield { type: "error", code: "cancelled", message: "Turn cancelled", sessionId };
        return;
      }
      if (reply.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs));
      text += word;
      yield { type: "text_delta", text: word };
    }
    if (input.signal.aborted) {
      yield { type: "error", code: "cancelled", message: "Turn cancelled", sessionId };
      return;
    }
    yield {
      type: "result",
      sessionId,
      text,
      durationMs: 0,
      numTurns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
