import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ModelRuntime, OutgoingServerMessage, RuntimeTurnInput } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime, type ScriptedReply } from "../runtime/scripted-runtime.js";
import { allTools } from "../tools/index.js";
import { ConversationStore } from "./conversation-store.js";
import { ConversationHub } from "./hub.js";
import { ConversationOrchestrator } from "./orchestrator.js";
import { TurnToolRegistry } from "./turn-tool-registry.js";

const noUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0 };
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function setup(
  sessionMaxTurns: number,
  overrides: {
    runtime?: ModelRuntime;
    toolRegistry?: TurnToolRegistry;
    textOnlySources?: Set<string>;
    sessionMaxContextTokens?: number;
    sessionIdleMs?: number;
    now?: () => Date;
    reply?: (input: RuntimeTurnInput) => ScriptedReply;
  } = {},
) {
  const db = openMigratedDatabase(":memory:");
  const store = new ConversationStore(db);
  const scripted = new ScriptedRuntime(overrides.reply ?? ((input) => ({ text: `ok: ${input.text}` })));
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
    sessionMaxContextTokens: overrides.sessionMaxContextTokens,
    sessionIdleMs: overrides.sessionIdleMs,
    now: overrides.now,
    log: silent,
  });
  return { db, store, hub, runtime: scripted, orchestrator, conversationId: store.create().id };
}

const turn = (conversationId: string, text: string) => ({
  conversationId,
  turnId: crypto.randomUUID(),
  text,
  inputMode: "text" as const,
  replyMode: "text" as const,
  inputEndedAt: performance.now(),
});

describe("prompt cache warm-up", () => {
  function warmSetup(start = Date.now()) {
    const clock = { now: start };
    const toolRegistry = new TurnToolRegistry();
    const scripted = new ScriptedRuntime(() => ({ text: "ok" }));
    const warmed: string[] = [];
    const runtime: ModelRuntime = {
      name: "warm-fixture",
      runTurn: (input) => scripted.runTurn(input),
      warm: async (turnId) => {
        expect(toolRegistry.require(turnId).allowedTools.length).toBeGreaterThan(0);
        warmed.push(turnId);
      },
    };
    const context = setup(40, { runtime, toolRegistry, now: () => new Date(clock.now) });
    return { ...context, clock, warmed, toolRegistry };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("warms once with the same tools as a turn and releases them", async () => {
    const { orchestrator, warmed, toolRegistry, conversationId } = warmSetup();
    orchestrator.warm(conversationId);
    orchestrator.warm(conversationId);
    await settle();
    orchestrator.warm(conversationId);
    await settle();
    expect(warmed).toHaveLength(1);
    expect(() => toolRegistry.require(warmed[0] as string)).toThrow();
  });

  it("does not warm right after a real turn, only after a long pause", async () => {
    const { orchestrator, warmed, clock, conversationId } = warmSetup();
    await orchestrator.startTurn(turn(conversationId, "hola"));
    orchestrator.warm(conversationId);
    await settle();
    expect(warmed).toHaveLength(0);
    clock.now += 51 * 60_000;
    orchestrator.warm(conversationId);
    await settle();
    expect(warmed).toHaveLength(1);
  });
});

describe("prepared turns", () => {
  function preparedSetup() {
    const toolRegistry = new TurnToolRegistry();
    const scripted = new ScriptedRuntime(() => ({ text: "Hola." }));
    const prepared: { turnId: string; resume: string | undefined }[] = [];
    const discarded: string[] = [];
    const usedToolsets: unknown[] = [];
    const runtime: ModelRuntime = {
      name: "prepared-fixture",
      runTurn: (input) => {
        usedToolsets.push(toolRegistry.require(input.turnId));
        return scripted.runTurn(input);
      },
      prepare: (turnId, resume) => void prepared.push({ turnId, resume }),
      discard: (turnId) => void discarded.push(turnId),
    };
    return { ...setup(40, { runtime, toolRegistry }), toolRegistry, prepared, discarded, usedToolsets };
  }

  it("starts the turn's process while the owner speaks and runs the turn with the same tools", async () => {
    const { orchestrator, conversationId, toolRegistry, prepared, discarded, usedToolsets } = preparedSetup();
    const spoken = { ...turn(conversationId, "qué hora es"), inputMode: "voice" as const };
    orchestrator.prepareTurn(conversationId, spoken.turnId);
    const toolset = toolRegistry.require(spoken.turnId);
    expect(prepared).toEqual([{ turnId: spoken.turnId, resume: undefined }]);
    await orchestrator.startTurn(spoken);
    expect(usedToolsets).toEqual([toolset]);
    expect(discarded).toEqual([]);
    expect(() => toolRegistry.require(spoken.turnId)).toThrow();
  });

  it("does not reuse a process prepared before another turn finished", async () => {
    const { orchestrator, conversationId, prepared, discarded, usedToolsets, toolRegistry } = preparedSetup();
    const spoken = { ...turn(conversationId, "y mañana?"), inputMode: "voice" as const };
    orchestrator.prepareTurn(conversationId, spoken.turnId);
    const stale = toolRegistry.require(spoken.turnId);
    await orchestrator.startTurn(turn(conversationId, "qué tengo hoy"));
    await orchestrator.startTurn(spoken);
    expect(prepared).toHaveLength(1);
    expect(discarded).toEqual([spoken.turnId]);
    expect(usedToolsets.at(-1)).not.toBe(stale);
  });

  it("does not prepare while the model is still writing the previous turn", async () => {
    const toolRegistry = new TurnToolRegistry();
    const scripted = new ScriptedRuntime(() => ({ text: "Listo." }));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prepared: string[] = [];
    const runtime: ModelRuntime = {
      name: "slow-fixture",
      async *runTurn(input) {
        await gate;
        yield* scripted.runTurn(input);
      },
      prepare: (turnId) => void prepared.push(turnId),
      discard: () => {},
    };
    const { orchestrator, conversationId } = setup(40, { runtime, toolRegistry });
    const writing = orchestrator.startTurn(turn(conversationId, "buscá algo largo"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    orchestrator.prepareTurn(conversationId, crypto.randomUUID());
    expect(prepared).toEqual([]);
    release();
    await writing;
    const next = crypto.randomUUID();
    orchestrator.prepareTurn(conversationId, next);
    expect(prepared).toEqual([next]);
  });

  it("keeps one prepared turn at a time and drops those that never run", () => {
    const { orchestrator, conversationId, toolRegistry, discarded } = preparedSetup();
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    orchestrator.prepareTurn(conversationId, first);
    orchestrator.prepareTurn(conversationId, second);
    orchestrator.discardPrepared(second);
    expect(discarded).toEqual([first, second]);
    expect(() => toolRegistry.require(first)).toThrow();
    expect(() => toolRegistry.require(second)).toThrow();
  });
});

describe("session rotation", () => {
  const say = async (ctx: ReturnType<typeof setup>, text: string) => {
    await ctx.orchestrator.startTurn(turn(ctx.conversationId, text));
    await ctx.orchestrator.settled();
  };

  it("rotates by turn count, summarizes from the database in the background and carries only uncovered messages", async () => {
    const ctx = setup(3);
    ctx.runtime.summarizer = () => "Acordaron jugar el viernes (propuesto, dicho por el dueño).";
    for (const text of ["uno", "dos", "tres"]) await say(ctx, text);
    const oldSession = ctx.store.get(ctx.conversationId)?.claude_session_id;
    expect(oldSession).toBeNull();
    expect(ctx.runtime.summaryPrompts).toHaveLength(1);
    expect(ctx.runtime.summaryPrompts[0]).toContain("Alex: uno");
    expect(ctx.runtime.summaryPrompts[0]).not.toContain("Alex: tres");

    await say(ctx, "cuatro");

    const fresh = ctx.runtime.calls.at(-1);
    expect(fresh?.resumeSessionId).toBeUndefined();
    expect(fresh?.seedContext).toContain("Resumen previo: Acordaron jugar el viernes");
    expect(fresh?.seedContext).toContain("Alex: tres");
    expect(fresh?.seedContext).not.toContain("Alex: uno");
    expect(ctx.runtime.calls.every((call) => !call.text.startsWith("Resumí"))).toBe(true);
  });

  it("rotates when the last call sent too much context", async () => {
    const ctx = setup(100, { sessionMaxContextTokens: 40_000, reply: () => ({ text: "ok", usage: { contextTokens: 50_000 } }) });
    await say(ctx, "uno");
    expect(ctx.store.get(ctx.conversationId)?.claude_session_id).toBeNull();
    await say(ctx, "dos");
    expect(ctx.runtime.calls.at(-1)?.resumeSessionId).toBeUndefined();
    expect(ctx.runtime.calls.at(-1)?.seedContext).toContain("Alex: uno");
  });

  it("keeps the session while the context is small", async () => {
    const ctx = setup(100, { sessionMaxContextTokens: 40_000, reply: () => ({ text: "ok", usage: { contextTokens: 10_000 } }) });
    await say(ctx, "uno");
    await say(ctx, "dos");
    expect(ctx.runtime.calls.at(-1)?.resumeSessionId).toBeDefined();
  });

  it("starts a fresh session after an idle gap because the cache is cold", async () => {
    const start = Date.now();
    let clock = new Date(start);
    const ctx = setup(100, { sessionIdleMs: 30 * 60_000, now: () => clock });
    await say(ctx, "uno");
    clock = new Date(start + 10 * 60_000);
    await say(ctx, "dos");
    expect(ctx.runtime.calls.at(-1)?.resumeSessionId).toBeDefined();
    clock = new Date(start + 2 * 3_600_000);
    await say(ctx, "tres");
    expect(ctx.runtime.calls.at(-1)?.resumeSessionId).toBeUndefined();
    expect(ctx.runtime.calls.at(-1)?.seedContext).toContain("Alex: dos");
  });

  it("waits for a summary still being written before seeding the fresh session", async () => {
    const ctx = setup(3);
    const summarize = ctx.runtime.summarize.bind(ctx.runtime);
    ctx.runtime.summarizer = () => "Quedaron en revisar el presupuesto.";
    ctx.runtime.summarize = async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return summarize(prompt);
    };
    for (const text of ["uno", "dos", "tres", "cuatro"]) await ctx.orchestrator.startTurn(turn(ctx.conversationId, text));

    expect(ctx.runtime.calls.at(-1)?.seedContext).toContain("Resumen previo: Quedaron en revisar el presupuesto.");
  });

  it("falls back to a clipped digest when the summary call fails, without losing context", async () => {
    const ctx = setup(3);
    ctx.runtime.summarizer = () => {
      throw new Error("haiku unavailable");
    };
    for (const text of ["uno", "dos", "tres"]) await say(ctx, text);
    await say(ctx, "cuatro");
    const seed = ctx.runtime.calls.at(-1)?.seedContext ?? "";
    expect(seed).toContain("Resumen previo: Alex: uno");
    expect(seed).toContain("Alex: tres");
  });

  it("does not repeat the current message in the seed when a session cannot be resumed", async () => {
    const ctx = setup(100);
    await say(ctx, "primero");
    ctx.runtime.forgetSession(ctx.store.get(ctx.conversationId)?.claude_session_id as string);
    await say(ctx, "segundo");
    const retry = ctx.runtime.calls.at(-1);
    expect(retry?.resumeSessionId).toBeUndefined();
    expect(retry?.seedContext).toContain("Alex: primero");
    expect(retry?.seedContext).not.toContain("segundo");
  });

  it("stores the token usage of each turn", async () => {
    const ctx = setup(100, {
      reply: () => ({ text: "ok", usage: { inputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 30, outputTokens: 5 } }),
    });
    await say(ctx, "uno");
    const row = ctx.db.prepare("SELECT input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens FROM turns").get();
    expect(row).toEqual({ input_tokens: 10, cache_read_tokens: 200, cache_creation_tokens: 30, output_tokens: 5 });
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
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: noUsage };
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

const voiceTurn = (conversationId: string, text: string) => ({ ...turn(conversationId, text), inputMode: "voice" as const, replyMode: "voice" as const });

function recordingSpeaker() {
  const spoken: string[] = [];
  return {
    spoken,
    createSpeaker: () => ({
      firstAudioAt: undefined,
      textDelta: (text: string) => void spoken.push(text),
      toolStarted: () => {},
      finish: async () => {},
      cancel: () => {},
    }),
  };
}

describe("voice turns cut before a reply", () => {
  function slowSetup() {
    const runtime: ModelRuntime & { calls: RuntimeTurnInput[] } = {
      name: "slow-fixture",
      calls: [],
      async *runTurn(input) {
        runtime.calls.push(input);
        yield { type: "session", sessionId: "s1", model: "fixture", tools: [], mcpServers: [], authSource: "fixture" };
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (input.signal.aborted) {
          yield { type: "error", code: "cancelled", message: "Turn cancelled", sessionId: "s1" };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: noUsage };
      },
    };
    return { ...setup(40, { runtime }), runtime };
  }

  const said = (input: RuntimeTurnInput) => input.text.split("\n\n").at(-1);

  it("joins what the owner said before a pause with what came after", async () => {
    const { orchestrator, runtime, conversationId } = slowSetup();
    const first = voiceTurn(conversationId, "mandale a Ana");
    const running = orchestrator.startTurn(first);
    orchestrator.cancel(first.turnId, "barge_in");
    await running;
    await orchestrator.startTurn(voiceTurn(conversationId, "que llego en diez"));

    expect(runtime.calls.map(said)).toEqual(["mandale a Ana", "mandale a Ana que llego en diez"]);
  });

  it("answers the cut question when the interruption was only noise", async () => {
    const { orchestrator, runtime, store, conversationId } = slowSetup();
    const first = voiceTurn(conversationId, "qué hora es");
    const running = orchestrator.startTurn(first);
    orchestrator.cancel(first.turnId, "barge_in");
    await running;
    const noise = voiceTurn(conversationId, "");
    await orchestrator.startTurn(noise);

    expect(runtime.calls.map(said)).toEqual(["qué hora es", "qué hora es"]);
    expect(store.turnMessages(noise.turnId).map((item) => item.role)).toEqual(["assistant"]);
  });

  it("does not resume a turn the owner stopped on purpose", async () => {
    const { orchestrator, runtime, conversationId } = slowSetup();
    const first = voiceTurn(conversationId, "contame un cuento");
    const running = orchestrator.startTurn(first);
    orchestrator.cancel(first.turnId, "user_stop");
    await running;
    await orchestrator.startTurn(voiceTurn(conversationId, ""));

    expect(runtime.calls).toHaveLength(1);
  });
});

describe("confirmations by reply", () => {
  function sendingSetup() {
    const toolRegistry = new TurnToolRegistry();
    const runtime: ModelRuntime & { calls: RuntimeTurnInput[] } = {
      name: "whatsapp-fixture",
      calls: [],
      async *runTurn(input) {
        runtime.calls.push(input);
        yield { type: "session", sessionId: "s1", model: "fixture", tools: [], mcpServers: [], authSource: "fixture" };
        if (input.text.endsWith("mandale a Ana que llego en diez")) {
          const server = toolRegistry.require(input.turnId).server;
          const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: "test", version: "0.0.0" });
          await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
          await client.callTool({ name: "whatsapp_send", arguments: { chatId: "Ana Vivo", text: "llego en 10" } });
          await client.close();
          yield { type: "text_delta", text: "Te lo preparo." };
        } else {
          yield { type: "text_delta", text: "ok" };
        }
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: noUsage };
      },
    };
    const context = setup(40, { runtime, toolRegistry });
    const { db } = context;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES ('5490000000001@s.whatsapp.net', 'Ana Vivo', 0, ?)").run(now);
    db.prepare("INSERT INTO wa_sync_state (source, status, last_event_at) VALUES ('baileys', 'connected', ?)").run(now);
    const outbox = () => db.prepare("SELECT text FROM wa_outbox").all();
    return { ...context, runtime, outbox };
  }

  it("reads the card aloud, and a spoken yes sends it without the model", async () => {
    const { orchestrator, runtime, outbox, conversationId } = sendingSetup();
    const asked = recordingSpeaker();
    await orchestrator.startTurn({ ...voiceTurn(conversationId, "mandale a Ana que llego en diez"), createSpeaker: asked.createSpeaker });
    expect(asked.spoken.join("")).toBe("Te lo preparo. Enviar WhatsApp. Para Ana Vivo. Mensaje: llego en 10. ¿Confirmo?");
    expect(outbox()).toEqual([]);

    const answered = recordingSpeaker();
    await orchestrator.startTurn({ ...voiceTurn(conversationId, "Sí, mandalo."), createSpeaker: answered.createSpeaker });
    expect(answered.spoken).toEqual(["Listo, hecho."]);
    expect(outbox()).toEqual([{ text: "llego en 10" }]);
    expect(runtime.calls).toHaveLength(1);

    await orchestrator.startTurn(voiceTurn(conversationId, "gracias"));
    expect(runtime.calls[1]?.text).toContain("[nota del sistema: el dueño confirmó por voz «Enviar WhatsApp: Para Ana Vivo»; resultado: hecho]");
  });

  it("only takes the answer from the turn right after the question", async () => {
    const { orchestrator, outbox, conversationId } = sendingSetup();
    await orchestrator.startTurn({ ...voiceTurn(conversationId, "mandale a Ana que llego en diez"), createSpeaker: recordingSpeaker().createSpeaker });
    await orchestrator.startTurn(turn(conversationId, "contame algo"));
    await orchestrator.startTurn(voiceTurn(conversationId, "sí"));

    expect(outbox()).toEqual([]);
  });

  it("asks briefly in a text reply, and a typed yes sends it", async () => {
    const { orchestrator, hub, runtime, outbox, conversationId } = sendingSetup();
    const seen: OutgoingServerMessage[] = [];
    hub.subscribe(conversationId, { send: (message) => seen.push(message) });
    await orchestrator.startTurn(turn(conversationId, "mandale a Ana que llego en diez"));
    expect(seen.find((message) => message.type === "assistant.done")).toMatchObject({ text: "Te lo preparo. ¿Confirmo «Enviar WhatsApp: Para Ana Vivo»?" });

    await orchestrator.startTurn(turn(conversationId, "dale"));
    expect(outbox()).toEqual([{ text: "llego en 10" }]);
    expect(runtime.calls).toHaveLength(1);

    await orchestrator.startTurn(turn(conversationId, "gracias"));
    expect(runtime.calls[1]?.text).toContain("[nota del sistema: el dueño confirmó por chat «Enviar WhatsApp: Para Ana Vivo»; resultado: hecho]");
  });

  it("forgets the question once the card is tapped, so a later yes goes to the model", async () => {
    const { orchestrator, runtime, db, conversationId } = sendingSetup();
    await orchestrator.startTurn(turn(conversationId, "mandale a Ana que llego en diez"));
    const { id } = db.prepare("SELECT id FROM pending_actions").get() as { id: string };
    await orchestrator.decideAction(id, "reject");
    await orchestrator.startTurn(turn(conversationId, "sí"));

    expect(runtime.calls).toHaveLength(2);
  });

  it("asks again about the only pending card when a yes comes after the question was lost", async () => {
    const { orchestrator, hub, runtime, outbox, conversationId } = sendingSetup();
    const seen: OutgoingServerMessage[] = [];
    hub.subscribe(conversationId, { send: (message) => seen.push(message) });
    await orchestrator.startTurn(turn(conversationId, "mandale a Ana que llego en diez"));
    await orchestrator.startTurn(turn(conversationId, "contame algo"));
    await orchestrator.startTurn(turn(conversationId, "Confirmar."));
    expect(outbox()).toEqual([]);
    expect(seen.filter((message) => message.type === "assistant.done").at(-1)).toMatchObject({ text: "¿Confirmo «Enviar WhatsApp: Para Ana Vivo»?" });

    await orchestrator.startTurn(turn(conversationId, "sí"));
    expect(outbox()).toEqual([{ text: "llego en 10" }]);
    expect(runtime.calls).toHaveLength(2);
  });

  it("a typed no discards the card", async () => {
    const { orchestrator, outbox, db, conversationId } = sendingSetup();
    await orchestrator.startTurn(turn(conversationId, "mandale a Ana que llego en diez"));
    await orchestrator.startTurn(turn(conversationId, "no, cancelalo"));

    expect(outbox()).toEqual([]);
    expect(db.prepare("SELECT status FROM pending_actions").all()).toEqual([{ status: "rejected" }]);
  });
});
