import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ModelRuntime, OutgoingServerMessage, RuntimeTurnInput } from "@jarvis/contracts";
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
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
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

describe("spoken confirmations", () => {
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
        yield { type: "result", sessionId: "s1", text: "", durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
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

  it("only listens for the answer right after the question, and never from typed text", async () => {
    const { orchestrator, outbox, conversationId } = sendingSetup();
    await orchestrator.startTurn({ ...voiceTurn(conversationId, "mandale a Ana que llego en diez"), createSpeaker: recordingSpeaker().createSpeaker });
    await orchestrator.startTurn(turn(conversationId, "sí"));
    await orchestrator.startTurn(voiceTurn(conversationId, "sí"));

    expect(outbox()).toEqual([]);
  });

  it("does not ask aloud when the reply is text", async () => {
    const { orchestrator, hub, conversationId } = sendingSetup();
    const seen: OutgoingServerMessage[] = [];
    hub.subscribe(conversationId, { send: (message) => seen.push(message) });
    await orchestrator.startTurn({ ...turn(conversationId, "mandale a Ana que llego en diez") });

    const done = seen.find((message) => message.type === "assistant.done");
    expect(done).toMatchObject({ text: "Te lo preparo." });
  });
});
