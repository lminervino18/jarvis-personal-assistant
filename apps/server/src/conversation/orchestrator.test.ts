import type { ModelRuntime } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { allTools } from "../tools/index.js";
import { ConversationStore } from "./conversation-store.js";
import { ConversationHub } from "./hub.js";
import { ConversationOrchestrator } from "./orchestrator.js";
import { TurnToolRegistry } from "./turn-tool-registry.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function setup(
  sessionMaxTurns: number,
  overrides: { runtime?: ModelRuntime; toolRegistry?: TurnToolRegistry; textOnlySources?: Set<string> } = {},
) {
  const db = openMigratedDatabase(":memory:");
  const store = new ConversationStore(db);
  const scripted = new ScriptedRuntime((input) => ({
    text: input.text.startsWith("Resumí") ? "Acordaron jugar el viernes (propuesto, dicho por el dueño)." : `ok: ${input.text}`,
  }));
  const hub = new ConversationHub();
  const orchestrator = new ConversationOrchestrator({
    store,
    hub,
    runtime: overrides.runtime ?? scripted,
    toolRegistry: overrides.toolRegistry ?? new TurnToolRegistry(),
    textOnlySources: overrides.textOnlySources,
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
    tools: allTools,
    builtinTools: [],
    ownerName: "Alex",
    sessionMaxTurns,
    log: silent,
  });
  return { store, hub, runtime: scripted, orchestrator, conversationId: store.create().id };
}

const turn = (conversationId: string, text: string) => ({
  conversationId,
  turnId: crypto.randomUUID(),
  text,
  inputMode: "text" as const,
  replyMode: "text" as const,
  inputEndedAt: performance.now(),
});

describe("session rotation", () => {
  it("summarizes the old session and seeds a fresh one with the summary and recent messages", async () => {
    const { store, runtime, orchestrator, conversationId } = setup(2);
    await orchestrator.startTurn(turn(conversationId, "podríamos jugar el viernes"));
    await orchestrator.startTurn(turn(conversationId, "a las 20"));
    const oldSession = store.get(conversationId)?.claude_session_id;
    expect(store.get(conversationId)?.session_turns).toBe(2);

    await orchestrator.startTurn(turn(conversationId, "¿qué quedó pendiente?"));

    const [summaryCall, freshCall] = runtime.calls.slice(2);
    expect(summaryCall?.text).toMatch(/^Resumí/);
    expect(summaryCall?.resumeSessionId).toBe(oldSession);
    expect(freshCall?.resumeSessionId).toBeUndefined();
    expect(freshCall?.seedContext).toContain("Resumen previo: Acordaron jugar el viernes");
    expect(freshCall?.seedContext).toContain("Alex: a las 20");

    const conversation = store.get(conversationId);
    expect(conversation?.claude_session_id).not.toBe(oldSession);
    expect(conversation?.session_turns).toBe(1);
    expect(store.history(conversationId, 50).items.some((item) => item.text.startsWith("Resumí"))).toBe(false);
  });
});


describe("sensitive content and voice", () => {
  it("stops speaking and keeps the reply as text once the turn read a text-only source", async () => {
    const toolRegistry = new TurnToolRegistry();
    const runtime: ModelRuntime = {
      name: "gmail-fixture",
      async *runTurn(input) {
        yield { type: "session", sessionId: "s1", model: "fixture", tools: [], mcpServers: [], authSource: "fixture" };
        yield { type: "tool_start", toolUseId: "t1", name: "mcp__jarvis__gmail_search" };
        toolRegistry.require(input.turnId).security.taintSources.add("gmail_search");
        yield { type: "tool_end", toolUseId: "t1", name: "mcp__jarvis__gmail_search", isError: false };
        yield { type: "text_delta", text: "Tu jefe te escribió sobre el contrato." };
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
      },
    };
    const { store, orchestrator, conversationId } = setup(40, { runtime, toolRegistry, textOnlySources: new Set(["gmail_search"]) });
    const events: string[] = [];
    const speaker = {
      firstAudioAt: undefined,
      textDelta: (text: string) => events.push(`delta:${text}`),
      toolStarted: () => events.push("tool"),
      finish: async () => {
        events.push("finish");
      },
      cancel: () => events.push("cancel"),
    };

    await orchestrator.startTurn({ ...turn(conversationId, "¿me escribió mi jefe?"), replyMode: "voice", createSpeaker: () => speaker });

    expect(events).toEqual(["tool", "cancel"]);
    expect(store.history(conversationId, 10).items.at(-1)?.text).toBe("Tu jefe te escribió sobre el contrato.");
  });
});

describe("turn retries and interrupted speech", () => {
  it("replays a finished turn instead of running it twice", async () => {
    const { hub, runtime, orchestrator, conversationId } = setup(40);
    const first = turn(conversationId, "hola");
    await orchestrator.startTurn(first);
    const seen: string[] = [];
    hub.subscribe(conversationId, { send: (message) => seen.push(message.type) });

    await orchestrator.startTurn(first);

    expect(runtime.calls).toHaveLength(1);
    expect(seen).toEqual(["history", "turn.end"]);
  });

  it("marks a reply as interrupted when its speech is cut", async () => {
    const { store, orchestrator, conversationId } = setup(40);
    const input = turn(conversationId, "contame algo largo");
    let release: () => void = () => {};
    const speaker = {
      firstAudioAt: undefined,
      textDelta: () => {},
      toolStarted: () => {},
      finish: () => new Promise<void>((resolve) => (release = resolve)),
      cancel: () => release(),
    };
    const createSpeaker = (signal: AbortSignal) => {
      signal.addEventListener("abort", () => release());
      return speaker;
    };
    const running = orchestrator.startTurn({ ...input, replyMode: "voice", createSpeaker });
    await new Promise((resolve) => setTimeout(resolve, 20));
    orchestrator.cancel(input.turnId, "user_stop");
    await running;

    const reply = store.turnMessages(input.turnId).find((item) => item.role === "assistant");
    expect(reply?.interrupted).toBe(true);
    expect(store.getTurn(input.turnId)?.status).toBe("cancelled");
  });
});

