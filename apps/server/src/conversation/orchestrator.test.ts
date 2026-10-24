import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { allTools } from "../tools/index.js";
import { ConversationStore } from "./conversation-store.js";
import { ConversationHub } from "./hub.js";
import { ConversationOrchestrator } from "./orchestrator.js";
import { TurnToolRegistry } from "./turn-tool-registry.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function setup(sessionMaxTurns: number) {
  const db = openMigratedDatabase(":memory:");
  const store = new ConversationStore(db);
  const runtime = new ScriptedRuntime((input) => ({
    text: input.text.startsWith("Resumí") ? "Acordaron jugar el viernes (propuesto, dicho por el dueño)." : `ok: ${input.text}`,
  }));
  const orchestrator = new ConversationOrchestrator({
    store,
    hub: new ConversationHub(),
    runtime,
    toolRegistry: new TurnToolRegistry(),
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
    tools: allTools,
    builtinTools: [],
    ownerName: "Alex",
    sessionMaxTurns,
    log: silent,
  });
  return { store, runtime, orchestrator, conversationId: store.create().id };
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
