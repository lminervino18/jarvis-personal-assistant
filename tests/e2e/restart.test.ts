import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack, waitUntil } from "./support/stack.js";
import type { E2eClient } from "./support/ws-client.js";

const OUTPUT = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const;
const minutes = (count: number) => count * 60_000;

interface ReminderRow {
  id: string;
  status: string;
}

describe("restarting the server and worker without losing data", () => {
  let stack: Stack;
  let client: E2eClient;
  let conversationId: string;
  const ids = { dueSoon: "", dueWhileDown: "" };

  beforeAll(async () => {
    stack = await Stack.create();
    await stack.startServer();
    await stack.startWorker();
    client = await stack.connect();
    conversationId = (await client.hello([OUTPUT])).conversationId;
  });

  afterAll(async () => {
    client.close();
    await stack.cleanup();
  });

  it("keeps conversations, memory and pending reminders after both processes are killed", async () => {
    const turnId = crypto.randomUUID();
    client.sendText(conversationId, turnId, "Anotá que prefiero el café sin azúcar.");
    await client.waitFor("turn.end", (event) => event.turnId === turnId);
    stack.insertMemory("Prefiere el café sin azúcar");
    ids.dueSoon = stack.insertReminder("Llamar a la contadora", new Date(Date.now() + 6_000));
    client.close();

    await stack.stopAll("SIGKILL");
    ids.dueWhileDown = stack.insertReminder("Pagar el alquiler", new Date(Date.now() - minutes(10)));

    await stack.startServer();
    await stack.startWorker();

    expect(stack.rows<{ content: string }>("SELECT content FROM memories WHERE status = 'active'")).toEqual([{ content: "Prefiere el café sin azúcar" }]);
    expect(stack.rows("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?", "azúcar")).toHaveLength(1);
    expect(stack.rows("SELECT id FROM conversations")).toHaveLength(1);

    client = await stack.connect();
    const ready = await client.hello([OUTPUT]);
    expect(ready.conversationId).toBe(conversationId);
    const history = await client.waitFor("history");
    expect(history.items.map((item) => item.text).slice(0, 2)).toEqual([
      "Anotá que prefiero el café sin azúcar.",
      "Recibido: Anotá que prefiero el café sin azúcar.",
    ]);
  });

  it("fires each reminder exactly once after the restart, flagging the overdue one as late", async () => {
    await waitUntil(
      () => stack.rows<ReminderRow>("SELECT id, status FROM reminders WHERE status = 'fired'").length === 2,
      "reminders were not fired after the restart",
    );
    const live = await client.waitFor("history", (event) => event.items.some((item) => item.text.includes("Llamar a la contadora")));
    expect(live.items.every((item) => item.role === "system")).toBe(true);

    const systemTexts = stack.rows<{ content: string }>("SELECT content FROM messages WHERE role = 'system' AND turn_id IS NULL ORDER BY rid").map((row) => row.content);
    expect(systemTexts).toHaveLength(2);
    expect(systemTexts.some((text) => text.startsWith("Recordatorio atrasado") && text.includes("Pagar el alquiler"))).toBe(true);
    expect(systemTexts).toContain("Recordatorio: Llamar a la contadora");

    await new Promise((resolveTick) => setTimeout(resolveTick, 2_500));
    const outbox = stack.rows<{ kind: string; status: string }>("SELECT kind, status FROM outbox");
    expect(outbox.filter((row) => row.kind === "chat_message")).toHaveLength(2);
    expect(outbox.every((row) => row.status === "sent")).toBe(true);
    expect(stack.rows("SELECT id FROM messages WHERE role = 'system' AND turn_id IS NULL")).toHaveLength(2);
  });

  it("recovers the conversation after a restart even though the scripted session is gone", async () => {
    const turnId = crypto.randomUUID();
    const sessionBefore = stack.rows<{ claude_session_id: string }>("SELECT claude_session_id FROM conversations")[0]?.claude_session_id;
    client.sendText(conversationId, turnId, "¿y mañana?");
    const end = await client.waitFor("turn.end", (event) => event.turnId === turnId);
    expect(end.status).toBe("completed");

    const sessionAfter = stack.rows<{ claude_session_id: string }>("SELECT claude_session_id FROM conversations")[0]?.claude_session_id;
    expect(sessionAfter).not.toBe(sessionBefore);
    expect(stack.server?.logs()).toContain("claude session could not be resumed; starting a seeded session");
    expect(stack.rows("SELECT id FROM conversations")).toHaveLength(1);
  });

  it("survives a graceful SIGTERM restart too", async () => {
    client.close();
    await stack.stopAll("SIGTERM");
    await stack.startServer();
    await stack.startWorker();
    const reconnected = await stack.connect();
    const ready = await reconnected.hello([OUTPUT]);
    expect(ready.conversationId).toBe(conversationId);
    const history = await reconnected.waitFor("history");
    expect(history.items.length).toBeGreaterThanOrEqual(6);
    reconnected.close();
  });
});
