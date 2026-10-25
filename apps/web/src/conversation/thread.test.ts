import type { Card, HistoryItem } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { emptyThread, reduceThread, threadView, type ThreadEvent, type ThreadState } from "./thread.js";

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-24T15:00:00.000Z";

function server<T extends ThreadEvent["type"]>(type: T, fields: object): Extract<ThreadEvent, { type: T }> {
  return { seq: 1, type, ...fields } as unknown as Extract<ThreadEvent, { type: T }>;
}

function apply(state: ThreadState, ...events: ThreadEvent[]): ThreadState {
  return events.reduce((acc, event) => reduceThread(acc, event, NOW), state);
}

function item(id: string, role: HistoryItem["role"], text: string, at: string, turnId: string | null = null, cards: Card[] = []): HistoryItem {
  return { id, turnId, role, text, at, interrupted: false, cards };
}

const readyEvent = (conversationId = CONVERSATION) =>
  server("ready", { conversationId, protocol: 1, owner: { displayName: "x" }, capabilities: {} });
const historyEvent = (items: HistoryItem[], hasMore = false, conversationId = CONVERSATION) =>
  server("history", { conversationId, items, hasMore });

const youtube = (title: string, autoplay = false): Card => ({
  kind: "youtube",
  requestId: "req-1",
  videoId: "dQw4w9WgXcQ",
  title,
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  autoplay,
});

const confirm = (status: "pending" | "confirmed"): Card => ({
  kind: "confirm",
  actionId: "act-1",
  title: "Enviar mensaje",
  summary: "resumen",
  details: [],
  expiresAt: "2026-10-24T16:00:00.000Z",
  status,
});

function attached(items: HistoryItem[] = []): ThreadState {
  return apply(emptyThread(), readyEvent(), historyEvent(items));
}

describe("thread history", () => {
  it("loads the first page after ready", () => {
    const state = attached([item("m1", "user", "hola", "2026-10-24T14:00:00.000Z", T1), item("m2", "assistant", "buenas", "2026-10-24T14:00:01.000Z", T1)]);
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(state.awaitingInitial).toBe(false);
  });

  it("ignores history for another conversation", () => {
    const state = apply(attached(), historyEvent([item("x", "user", "?", NOW)], false, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(state.messages).toEqual([]);
  });

  it("resets the thread when the conversation changes", () => {
    const state = apply(attached([item("m1", "user", "hola", NOW, T1)]), readyEvent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(state.messages).toEqual([]);
    expect(state.conversationId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("prepends an older page without duplicating known messages", () => {
    const base = attached([item("m3", "user", "tres", "2026-10-24T14:00:03.000Z", T2)]);
    const state = apply(
      base,
      { type: "local.older" },
      historyEvent([item("m1", "user", "uno", "2026-10-24T14:00:01.000Z"), item("m2", "assistant", "dos", "2026-10-24T14:00:02.000Z")], true),
    );
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(state.hasMore).toBe(true);
    expect(state.loadingOlder).toBe(false);
  });

  it("keeps older pages, unsent user messages and a streaming reply across a reconnect", () => {
    let state = attached([item("m2", "user", "dos", "2026-10-24T14:00:02.000Z", T1)]);
    state = apply(
      state,
      { type: "local.older" },
      historyEvent([item("m1", "user", "uno", "2026-10-24T14:00:01.000Z")], false),
      { type: "local.user", turnId: T2, text: "mensaje pendiente" },
      readyEvent(),
      historyEvent([item("m2", "user", "dos", "2026-10-24T14:00:02.000Z", T1)], true),
    );
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", `local:user:${T2}`]);
    expect(state.messages[2]?.unsent).toBe(true);
  });

  it("replaces a local user message by the server's copy of the same turn", () => {
    const state = apply(
      attached(),
      { type: "local.user", turnId: T1, text: "hola" },
      readyEvent(),
      historyEvent([item("m1", "user", "hola", NOW, T1)]),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: "m1", local: false, unsent: false });
  });
});

describe("thread turns", () => {
  it("streams assistant text and settles it with the server's message", () => {
    let state = apply(attached(), { type: "local.user", turnId: T1, text: "hola" }, server("assistant.delta", { turnId: T1, text: "Buen" }), server("assistant.delta", { turnId: T1, text: "as" }));
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Buenas", streaming: true });
    state = apply(state, server("assistant.done", { turnId: T1, messageId: "m9", text: "Buenas tardes", interrupted: false }), server("turn.end", { turnId: T1, status: "completed" }));
    expect(state.messages.map((m) => m.id)).toEqual([`local:user:${T1}`, "m9"]);
    expect(state.messages.at(-1)).toMatchObject({ text: "Buenas tardes", streaming: false, local: false });
  });

  it("marks interrupted replies and stops streaming on turn end", () => {
    const state = apply(
      attached(),
      server("assistant.delta", { turnId: T1, text: "parcial" }),
      server("assistant.done", { turnId: T1, messageId: "m1", text: "parcial", interrupted: true }),
    );
    expect(state.messages[0]).toMatchObject({ interrupted: true, streaming: false });
    const cancelled = apply(attached(), server("assistant.delta", { turnId: T1, text: "x" }), server("turn.end", { turnId: T1, status: "cancelled" }));
    expect(cancelled.messages[0]?.streaming).toBe(false);
  });

  it("shows a voice transcript until the user message arrives", () => {
    let state = apply(attached(), server("transcript", { turnId: T1, text: "qué hora", final: false }));
    expect(state.transcript).toEqual({ turnId: T1, text: "qué hora", final: false });
    state = apply(state, server("transcript", { turnId: T1, text: "qué hora es", final: true }), historyEvent([item("m1", "user", "qué hora es", NOW, T1)]));
    expect(state.transcript).toBeNull();
    expect(apply(attached(), server("transcript", { turnId: T1, text: " ", final: true })).transcript).toBeNull();
  });

  it("shows turn errors in the thread as system messages", () => {
    const state = apply(attached(), server("error", { code: "stt_failed", message: "No pude transcribir", turnId: T1, retryable: true }));
    expect(state.messages[0]).toMatchObject({ role: "system", text: "No pude transcribir" });
    expect(apply(attached(), server("error", { code: "internal", message: "x", retryable: true })).messages).toHaveLength(0);
  });
});

describe("thread cards", () => {
  it("attaches cards to the turn's reply and replaces updated versions by identity", () => {
    let state = apply(attached(), server("card", { turnId: T1, card: confirm("pending") }), server("card", { turnId: T1, card: youtube("Uno") }));
    expect(state.messages[0]?.cards).toHaveLength(2);
    state = apply(state, server("card", { turnId: T1, card: confirm("confirmed") }));
    expect(state.messages[0]?.cards).toHaveLength(2);
    expect(state.messages[0]?.cards[0]).toMatchObject({ kind: "confirm", status: "confirmed" });
  });

  it("updates a card that already lives in an earlier message when the status update has no turn", () => {
    const state = apply(attached(), server("card", { turnId: T1, card: confirm("pending") }), server("assistant.done", { turnId: T1, messageId: "m1", text: "ok", interrupted: false }), server("card", { card: confirm("confirmed") }));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.cards[0]).toMatchObject({ status: "confirmed" });
  });

  it("creates a system message for a standalone card", () => {
    const state = apply(attached(), server("card", { card: { kind: "push_permission", reason: "Para avisarte" } }));
    expect(state.messages[0]).toMatchObject({ role: "system", text: "" });
    expect(state.messages[0]?.cards).toHaveLength(1);
  });

  it("keeps confirm and player cards in the place where they first appeared with the latest version", () => {
    const first = item("m1", "assistant", "mirá", NOW, T1, [confirm("pending"), youtube("Uno")]);
    const second = item("m2", "assistant", "listo", NOW, T2, [confirm("confirmed"), youtube("Dos")]);
    const view = threadView(attached([first, second]).messages);
    expect(view[0]?.cards[0]).toMatchObject({ kind: "confirm", status: "confirmed" });
    expect(view[0]?.cards[1]).toMatchObject({ kind: "youtube", title: "Dos" });
    expect(view[1]?.cards).toEqual([]);
  });
});
