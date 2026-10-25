import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack, waitUntil } from "./support/stack.js";
import type { E2eClient } from "./support/ws-client.js";

const OUTPUT = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const;

describe("reminders while Claude is unavailable", () => {
  let stack: Stack;
  let client: E2eClient;
  let conversationId: string;

  beforeAll(async () => {
    stack = await Stack.create({ serverEnv: { RUNTIME: "claude", CLAUDE_CONFIG_DIR: "/nonexistent/claude-config" } });
    await stack.startServer();
    await stack.startWorker();
    client = await stack.connect();
    conversationId = (await client.hello([OUTPUT])).conversationId;
  });

  afterAll(async () => {
    client.close();
    await stack.cleanup();
  });

  it("fires a due reminder into the chat before any Claude call", async () => {
    stack.insertReminder("Tomar la medicación", new Date(Date.now() - 1_000));
    const live = await client.waitFor("history", (event) => event.items.some((item) => item.text === "Recordatorio: Tomar la medicación"));
    const item = live.items[0];
    expect(item?.role).toBe("system");
    expect(item?.cards[0]).toMatchObject({ kind: "reminder", status: "fired", text: "Tomar la medicación" });
  });

  it("reports Claude as unavailable in Spanish without taking the server down", async () => {
    const turnId = crypto.randomUUID();
    client.sendText(conversationId, turnId, "¿Qué tengo hoy?");
    const error = await client.waitFor("error", (event) => event.turnId === turnId, 45_000);
    expect(["claude_auth_failed", "claude_unavailable"]).toContain(error.code);
    expect(error.message).toMatch(/Claude/);
    const end = await client.waitFor("turn.end", (event) => event.turnId === turnId);
    expect(end.status).toBe("failed");
    expect((await fetch(`${stack.baseUrl}/healthz`)).ok).toBe(true);
    expect(stack.logs).not.toContain("¿Qué tengo hoy?");
  });

  it("still fires reminders created after the Claude failure, exactly once", async () => {
    stack.insertReminder("Sacar la basura", new Date(Date.now() - 1_000));
    await client.waitFor("history", (event) => event.items.some((item) => item.text === "Recordatorio: Sacar la basura"));
    await new Promise((resolveTick) => setTimeout(resolveTick, 2_500));

    await waitUntil(() => stack.rows("SELECT id FROM reminders WHERE status = 'fired'").length === 2, "both reminders should be fired");
    const texts = stack.rows<{ content: string }>("SELECT content FROM messages WHERE role = 'system' AND content LIKE 'Recordatorio:%'").map((row) => row.content);
    expect(texts.toSorted()).toEqual(["Recordatorio: Sacar la basura", "Recordatorio: Tomar la medicación"]);
    expect(stack.worker?.logs()).not.toMatch(/claude/i);
  });
});
