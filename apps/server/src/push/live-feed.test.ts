import type { OutgoingServerMessage } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../conversation/conversation-store.js";
import { ConversationHub } from "../conversation/hub.js";
import { openMigratedDatabase } from "../db/database.js";
import { SystemMessageFeed } from "./live-feed.js";

const NOW = new Date("2026-10-24T15:00:00.000Z");

describe("system message feed", () => {
  function collect(hub: ConversationHub, conversationId: string): OutgoingServerMessage[] {
    const received: OutgoingServerMessage[] = [];
    hub.subscribe(conversationId, { send: (message) => received.push(message) });
    return received;
  }

  it("emits new turn-less system messages as history items and ignores earlier and conversational ones", () => {
    const db = openMigratedDatabase(":memory:");
    const store = new ConversationStore(db);
    const hub = new ConversationHub();
    const conversation = store.create(NOW);
    const other = store.create(NOW);
    store.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: "Anterior al arranque" });
    const feed = new SystemMessageFeed(db, hub, { error: () => {} });
    const received = collect(hub, conversation.id);
    const otherReceived = collect(hub, other.id);

    store.appendMessage({ conversationId: conversation.id, turnId: null, role: "user", content: "Hola" });
    const card = { kind: "reminder" as const, reminderId: "r-1", text: "Llamar", dueAt: "2026-10-24T12:00:00-03:00", timezone: "America/Argentina/Buenos_Aires", status: "fired" as const };
    const first = store.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: "Recordatorio: Llamar", cards: [card] });
    const second = store.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: "Recordatorio: Otro" });
    expect(feed.poll()).toBe(2);

    expect(received).toEqual([
      {
        type: "history",
        conversationId: conversation.id,
        hasMore: false,
        items: [
          { id: first.id, turnId: null, role: "system", text: "Recordatorio: Llamar", at: first.at, interrupted: false, cards: [card] },
          { id: second.id, turnId: null, role: "system", text: "Recordatorio: Otro", at: second.at, interrupted: false, cards: [] },
        ],
      },
    ]);
    expect(otherReceived).toEqual([]);
    expect(feed.poll()).toBe(0);
  });

  it("polls on a timer until stopped", async () => {
    const db = openMigratedDatabase(":memory:");
    const store = new ConversationStore(db);
    const hub = new ConversationHub();
    const conversation = store.create(NOW);
    const received = collect(hub, conversation.id);
    const feed = new SystemMessageFeed(db, hub, { error: () => {} }, 10);
    feed.start();
    store.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: "Aviso" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    feed.stop();
    store.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: "Tarde" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(received).toHaveLength(1);
  });
});
