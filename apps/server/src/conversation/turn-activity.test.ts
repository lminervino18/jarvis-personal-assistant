import type { ActivityEvent, OutgoingServerMessage, RuntimeEvent } from "@jarvis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime, type ScriptedReply } from "../runtime/scripted-runtime.js";
import { allTools } from "../tools/index.js";
import { ConversationStore } from "./conversation-store.js";
import { ConversationHub } from "./hub.js";
import { ConversationOrchestrator } from "./orchestrator.js";
import { TurnActivity } from "./turn-activity.js";
import { TurnToolRegistry } from "./turn-tool-registry.js";

const conversationId = crypto.randomUUID();
const turnId = crypto.randomUUID();

function tracker(waitingAfterMs = 5000) {
  const sent: ActivityEvent[] = [];
  const activity = new TurnActivity({ conversationId, turnId, send: (event) => sent.push(event), waitingAfterMs });
  return { activity, sent };
}

describe("TurnActivity", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("reports each phase once, with the tool's own name and a growing version", () => {
    const { activity, sent } = tracker();
    activity.preparing("t1", "mcp__jarvis__gmail_search");
    activity.running("t1", "mcp__jarvis__gmail_search");
    activity.ended("t1", "mcp__jarvis__gmail_search", { isError: false });
    expect(sent.map((event) => [event.tool, event.phase, event.version])).toEqual([
      ["gmail_search", "preparing", 1],
      ["gmail_search", "running", 2],
      ["gmail_search", "succeeded", 3],
    ]);
  });

  it("ignores duplicates, regressions and anything after the end", () => {
    const { activity, sent } = tracker();
    activity.running("t1", "WebSearch");
    activity.running("t1", "WebSearch");
    activity.preparing("t1", "WebSearch");
    activity.ended("t1", "WebSearch", { isError: true, errorCode: "upstream_error" });
    activity.ended("t1", "WebSearch", { isError: false });
    activity.running("t1", "WebSearch");
    expect(sent.map((event) => event.phase)).toEqual(["running", "failed"]);
    expect(sent[1]?.errorCode).toBe("upstream_error");
  });

  it("tells a call stopped for the owner's approval from a success", () => {
    const { activity, sent } = tracker();
    activity.running("t1", "mcp__jarvis__gmail_send");
    activity.ended("t1", "mcp__jarvis__gmail_send", { isError: false, errorCode: "needs_confirmation" });
    expect(sent.at(-1)?.phase).toBe("needs_approval");
  });

  it("reports waiting only for a call that keeps running, and never after it ends", () => {
    const { activity, sent } = tracker(5000);
    activity.running("slow", "mcp__jarvis__drive_search");
    activity.running("fast", "mcp__jarvis__memory_search");
    activity.ended("fast", "mcp__jarvis__memory_search", { isError: false });
    vi.advanceTimersByTime(5000);
    expect(sent.filter((event) => event.phase === "waiting").map((event) => event.executionId)).toEqual(["slow"]);
    activity.ended("slow", "mcp__jarvis__drive_search", { isError: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes what is left open when the turn ends and lists only what is in progress", () => {
    const { activity, sent } = tracker();
    activity.running("a", "WebSearch");
    activity.running("b", "mcp__jarvis__drive_search");
    activity.ended("b", "mcp__jarvis__drive_search", { isError: false });
    expect(activity.open().map((event) => event.executionId)).toEqual(["a"]);
    activity.settle("cancelled");
    expect(sent.at(-1)).toMatchObject({ executionId: "a", phase: "cancelled" });
    expect(activity.open()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps working when the sender throws", () => {
    const activity = new TurnActivity({
      conversationId,
      turnId,
      send: () => {
        throw new Error("socket gone");
      },
    });
    expect(() => activity.running("t1", "WebSearch")).not.toThrow();
  });
});

describe("activity in a turn", () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  async function runTurnWith(
    events: RuntimeEvent[],
    reply: Partial<ScriptedReply> = {},
    cancelAfterMs?: number,
    probe?: (message: OutgoingServerMessage, openNow: () => ActivityEvent[]) => void,
  ) {
    const db = openMigratedDatabase(":memory:");
    const store = new ConversationStore(db);
    const hub = new ConversationHub();
    const orchestrator = new ConversationOrchestrator({
      store,
      hub,
      runtime: new ScriptedRuntime(() => ({ text: "Listo.", events, ...reply })),
      toolRegistry: new TurnToolRegistry(),
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
      tools: allTools,
      builtinTools: [],
      ownerName: "Alex",
      sessionMaxTurns: 40,
      log: silent,
    });
    const id = store.create().id;
    const seen: OutgoingServerMessage[] = [];
    hub.subscribe(id, {
      send: (message) => {
        seen.push(message);
        probe?.(message, () => orchestrator.openActivity(id));
      },
    });
    const id2 = crypto.randomUUID();
    const running = orchestrator.startTurn({ conversationId: id, turnId: id2, text: "hola", inputMode: "text", replyMode: "text", inputEndedAt: performance.now() });
    if (cancelAfterMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, cancelAfterMs));
      orchestrator.cancel(id2, "user_stop");
    }
    await running;
    return { seen, activity: seen.filter((message) => message.type === "activity") };
  }

  it("follows a tool from the call to its result, before the turn ends", async () => {
    const { seen, activity } = await runTurnWith([
      { type: "tool_start", toolUseId: "t1", name: "mcp__jarvis__gmail_search" },
      { type: "tool_run", toolUseId: "t1", name: "mcp__jarvis__gmail_search" },
      { type: "tool_end", toolUseId: "t1", name: "mcp__jarvis__gmail_search", isError: false },
    ]);
    expect(activity.map((message) => message.phase)).toEqual(["preparing", "running", "succeeded"]);
    const order = seen.map((message) => message.type);
    expect(order.lastIndexOf("activity")).toBeLessThan(order.indexOf("turn.end"));
  });

  it("sends nothing for an answer that used no tools", async () => {
    const { activity } = await runTurnWith([]);
    expect(activity).toEqual([]);
  });

  it("shows two parallel calls as two executions of the same turn", async () => {
    const { activity } = await runTurnWith([
      { type: "tool_start", toolUseId: "a", name: "mcp__jarvis__gmail_search" },
      { type: "tool_start", toolUseId: "b", name: "mcp__jarvis__drive_search" },
      { type: "tool_run", toolUseId: "a", name: "mcp__jarvis__gmail_search" },
      { type: "tool_run", toolUseId: "b", name: "mcp__jarvis__drive_search" },
      { type: "tool_end", toolUseId: "b", name: "mcp__jarvis__drive_search", isError: true, errorCode: "upstream_error" },
      { type: "tool_end", toolUseId: "a", name: "mcp__jarvis__gmail_search", isError: false },
    ]);
    const finals = activity.filter((message) => message.type === "activity" && ["succeeded", "failed"].includes(message.phase));
    expect(finals.map((message) => message.type === "activity" && [message.executionId, message.phase])).toEqual([
      ["b", "failed"],
      ["a", "succeeded"],
    ]);
  });

  it("lets a client that attaches mid-turn see what is still running", async () => {
    const midTurn: ActivityEvent[][] = [];
    const { activity } = await runTurnWith(
      [{ type: "tool_run", toolUseId: "t1", name: "WebSearch" }],
      {},
      undefined,
      (message, openNow) => message.type === "activity" && midTurn.push(openNow()),
    );
    expect(midTurn[0]?.map((event) => [event.executionId, event.phase])).toEqual([["t1", "running"]]);
    expect(activity.at(-1)).toMatchObject({ phase: "cancelled" });
  });

  it("cancels the calls still open when the owner stops the turn", async () => {
    const { activity } = await runTurnWith(
      [
        { type: "tool_start", toolUseId: "t1", name: "WebSearch" },
        { type: "tool_run", toolUseId: "t1", name: "WebSearch" },
      ],
      { text: "Seguimos con la búsqueda. ".repeat(20), chunkDelayMs: 20 },
      80,
    );
    expect(activity.at(-1)).toMatchObject({ type: "activity", executionId: "t1", phase: "cancelled" });
  });
});
