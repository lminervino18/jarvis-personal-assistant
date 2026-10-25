import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtinTools, type ServerMessage } from "@jarvis/contracts";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { loadConfig } from "./config.js";
import { ConversationStore } from "./conversation/conversation-store.js";
import { ConversationHub } from "./conversation/hub.js";
import { ConversationOrchestrator } from "./conversation/orchestrator.js";
import { TurnToolRegistry } from "./conversation/turn-tool-registry.js";
import { openMigratedDatabase } from "./db/database.js";
import { ScriptedRuntime, type ScriptedReply } from "./runtime/scripted-runtime.js";
import { loadAssistantContext } from "./runtime/system-prompt.js";
import { allTools } from "./tools/index.js";
import { unavailableStt, unavailableTts } from "./voice/types.js";

const PASSWORD = "correct horse battery staple";
const passwordHash = await hashPassword(PASSWORD);
const assistantDir = resolve(import.meta.dirname, "../../../assistant");
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(dataDir: string, runtime: ScriptedRuntime, webDistDir?: string) {
  const config = loadConfig({
    ...(webDistDir ? { WEB_DIST_DIR: webDistDir } : {}),
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    PORT: "8080",
    PUBLIC_ORIGIN: "http://localhost:5173",
    OWNER_PASSWORD_HASH: passwordHash,
    LOG_LEVEL: "fatal",
  });
  const db = openMigratedDatabase(config.dbPath);
  const store = new ConversationStore(db);
  const hub = new ConversationHub();
  const logger = pino({ level: "silent" });
  const app = await buildApp({
    config,
    logger,
    db,
    store,
    hub,
    assistantContext: () =>
      loadAssistantContext({
        instructionsPath: join(assistantDir, "CLAUDE.md"),
        privateProfilePath: join(dataDir, "memory", "loren.md"),
        exampleProfilePath: join(assistantDir, "loren.example.md"),
        allowExampleProfile: true,
        ownerDisplayName: "Alex",
        timezone: config.timezone,
      }),
    stt: unavailableStt,
    tts: unavailableTts,
    orchestrator: new ConversationOrchestrator({
      store,
      hub,
      runtime,
      toolRegistry: new TurnToolRegistry(),
      services: { db, timezone: config.timezone, backupRetentionDays: 30, statusSources: [] },
      tools: allTools,
      builtinTools,
      ownerName: "Alex",
      sessionMaxTurns: 40,
      log: logger,
    }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const stop = async () => {
    await app.close();
    db.close();
  };
  return { app, db, port, stop };
}

async function login(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie.split(";")[0] as string;
}

class TestClient {
  readonly messages: ServerMessage[] = [];
  private waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
  }

  static async connect(port: number, cookie: string): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: "http://localhost:5173" } });
    const client = new TestClient(socket);
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor<T extends ServerMessage["type"]>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
    const existing = this.messages.find((m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
      this.waiters.push({
        predicate: (m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolveMessage(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  async hello(conversationId?: string) {
    this.send({
      type: "hello",
      protocol: 1,
      client: { kind: "web", version: "test" },
      audio: { input: [], output: [] },
      ...(conversationId ? { conversationId } : {}),
    });
    return this.waitFor("ready");
  }

  close(): void {
    this.socket.close();
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-app-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rejectedUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    socket.on("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
    socket.on("open", () => resolveStatus(101));
    socket.on("error", () => {});
  });
}

describe("server", () => {
  it("rejects anonymous access, bad passwords and foreign origins", async () => {
    const server = await startServer(tempDir(), new ScriptedRuntime());
    cleanups.push(server.stop);

    expect(await rejectedUpgrade(server.port, { origin: "http://localhost:5173" })).toBe(401);
    const cookie = await login(server.port);
    expect(await rejectedUpgrade(server.port, { origin: "https://evil.example", cookie })).toBe(403);

    const bad = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ password: "wrong password" }),
    });
    expect(bad.status).toBe(401);

    const crossSite = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(crossSite.status).toBe(403);

    const context = await fetch(`http://127.0.0.1:${server.port}/api/health/context`);
    expect(context.status).toBe(401);
  });

  it("streams a turn, resumes the same session for follow-ups and survives a restart", async () => {
    const dataDir = tempDir();
    const runtime = new ScriptedRuntime((input) => ({ text: input.text.includes("mañana") ? "Mañana tenés dentista." : "Hoy nada." }));
    const first = await startServer(dataDir, runtime);
    const cookie = await login(first.port);
    const client = await TestClient.connect(first.port, cookie);
    const ready = await client.hello();
    const conversationId = ready.conversationId;

    const turn1 = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: turn1, text: "¿Qué tengo hoy?", replyMode: "text" });
    await client.waitFor("turn.end", (m) => m.turnId === turn1);
    expect(client.messages.some((m) => m.type === "assistant.delta" && m.turnId === turn1)).toBe(true);
    expect(client.messages.some((m) => m.type === "state" && m.state === "thinking")).toBe(true);

    const turn2 = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: turn2, text: "¿y mañana?", replyMode: "text" });
    const done = await client.waitFor("assistant.done", (m) => m.turnId === turn2);
    expect(done.text).toBe("Mañana tenés dentista.");
    const [call1, call2] = runtime.calls;
    expect(call1?.resumeSessionId).toBeUndefined();
    expect(call2?.resumeSessionId).toBeDefined();
    const seqs = client.messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    client.close();
    await first.stop();

    const second = await startServer(dataDir, runtime);
    cleanups.push(second.stop);
    const cookieAfterRestart = await login(second.port);
    const again = await TestClient.connect(second.port, cookieAfterRestart);
    cleanups.push(() => again.close());
    const readyAgain = await again.hello(conversationId);
    expect(readyAgain.conversationId).toBe(conversationId);
    const history = await again.waitFor("history");
    expect(history.items.map((item) => item.text)).toEqual(["¿Qué tengo hoy?", "Hoy nada.", "¿y mañana?", "Mañana tenés dentista."]);

    const turn3 = crypto.randomUUID();
    again.send({ type: "user.text", conversationId, turnId: turn3, text: "gracias", replyMode: "text" });
    await again.waitFor("turn.end", (m) => m.turnId === turn3);
    expect(runtime.calls[2]?.resumeSessionId).toBe(call2?.resumeSessionId);
  });

  it("cancels a running turn, keeps the partial text and lets a new turn supersede an old one", async () => {
    const replies: ScriptedReply = { text: "uno dos tres cuatro cinco seis siete ocho nueve diez", chunkDelayMs: 40 };
    const server = await startServer(tempDir(), new ScriptedRuntime(() => replies));
    cleanups.push(server.stop);
    const client = await TestClient.connect(server.port, await login(server.port));
    cleanups.push(() => client.close());
    const { conversationId } = await client.hello();

    const turn = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: turn, text: "contá", replyMode: "text" });
    await client.waitFor("assistant.delta", (m) => m.turnId === turn);
    client.send({ type: "turn.cancel", turnId: turn, reason: "user_stop" });
    const end = await client.waitFor("turn.end", (m) => m.turnId === turn);
    expect(end.status).toBe("cancelled");
    const done = await client.waitFor("assistant.done", (m) => m.turnId === turn);
    expect(done.interrupted).toBe(true);
    expect(done.text.length).toBeLessThan(replies.text!.length);

    const old = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: old, text: "primero", replyMode: "text" });
    await client.waitFor("assistant.delta", (m) => m.turnId === old);
    client.send({ type: "user.text", conversationId, turnId: fresh, text: "segundo", replyMode: "text" });
    expect((await client.waitFor("turn.end", (m) => m.turnId === old)).status).toBe("cancelled");
    expect((await client.waitFor("turn.end", (m) => m.turnId === fresh)).status).toBe("completed");
  });

  it("starts a seeded session when Claude cannot resume the stored one", async () => {
    const runtime = new ScriptedRuntime((input) => ({ text: `ok ${input.text}` }));
    const server = await startServer(tempDir(), runtime);
    cleanups.push(server.stop);
    const client = await TestClient.connect(server.port, await login(server.port));
    cleanups.push(() => client.close());
    const { conversationId } = await client.hello();

    const t1 = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: t1, text: "el partido es el viernes", replyMode: "text" });
    await client.waitFor("turn.end", (m) => m.turnId === t1);
    runtime.forgetSession(runtime.calls[0]?.resumeSessionId ?? (server.db.prepare("SELECT claude_session_id AS s FROM conversations").get() as { s: string }).s);

    const t2 = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId: t2, text: "¿cuándo era?", replyMode: "text" });
    const end = await client.waitFor("turn.end", (m) => m.turnId === t2);
    expect(end.status).toBe("completed");
    const retry = runtime.calls.at(-1);
    expect(retry?.resumeSessionId).toBeUndefined();
    expect(retry?.seedContext).toContain("el partido es el viernes");
  });

  it("reports quota exhaustion as a structured, persisted failure", async () => {
    const runtime = new ScriptedRuntime(() => ({
      error: { type: "error", code: "quota_exceeded", message: "limit", retryAfterMs: 3_600_000 },
    }));
    const server = await startServer(tempDir(), runtime);
    cleanups.push(server.stop);
    const client = await TestClient.connect(server.port, await login(server.port));
    cleanups.push(() => client.close());
    const { conversationId } = await client.hello();
    const turnId = crypto.randomUUID();
    client.send({ type: "user.text", conversationId, turnId, text: "hola", replyMode: "text" });
    const error = await client.waitFor("error", (m) => m.turnId === turnId);
    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toMatch(/recordatorios existentes siguen funcionando/);
    expect((await client.waitFor("turn.end", (m) => m.turnId === turnId)).status).toBe("failed");
  });

  it("serves the app shell for routes but 404s for missing static files", async () => {
    const dist = tempDir();
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dist, "assets", "app-123.js"), "console.log(1)");
    const server = await startServer(tempDir(), new ScriptedRuntime(), dist);
    cleanups.push(server.stop);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/assets/app-123.js`)).status).toBe(200);
    expect((await fetch(`${base}/assets/app-old.js`)).status).toBe(404);
    const route = await fetch(`${base}/conversacion?x=1`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("shell");
  });

  it("skips the history page for clients that opt out in hello", async () => {
    const server = await startServer(tempDir(), new ScriptedRuntime());
    cleanups.push(server.stop);
    const cookie = await login(server.port);
    const first = await TestClient.connect(server.port, cookie);
    cleanups.push(() => first.close());
    const { conversationId } = await first.hello();
    const turnId = crypto.randomUUID();
    first.send({ type: "user.text", conversationId, turnId, text: "hola", replyMode: "text" });
    await first.waitFor("turn.end", (m) => m.turnId === turnId);

    const device = await TestClient.connect(server.port, cookie);
    cleanups.push(() => device.close());
    device.send({ type: "hello", protocol: 1, client: { kind: "device", version: "test" }, audio: { input: [], output: [] }, conversationId, history: false });
    await device.waitFor("ready");
    await device.waitFor("state");
    expect(device.messages.some((m) => m.type === "history")).toBe(false);
  });
});

