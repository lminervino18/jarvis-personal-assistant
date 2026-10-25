import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { E2eClient } from "./ws-client.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const serverDist = resolve(repoRoot, "apps/server/dist");

export const OWNER_PASSWORD = "e2e-synthetic-password";
export const PUBLIC_ORIGIN = "http://jarvis.e2e.test";

export interface ManagedProcess {
  logs(): string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface StackOptions {
  serverEnv?: Record<string, string>;
}

/** Same scrypt parameters and format as `apps/server/src/auth/password.ts`. */
export function syntheticPasswordHash(password: string): string {
  const params = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 32, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
}

function manage(child: ChildProcess): ManagedProcess {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  return {
    logs: () => output,
    async stop(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * A real J.A.R.V.IS deployment in a temp directory: the built server and worker run as child
 * processes against one SQLite file, and tests talk to them over HTTP and WebSocket only.
 */
export class Stack {
  server?: ManagedProcess;
  worker?: ManagedProcess;
  private cookie?: string;
  private database?: Database.Database;

  private constructor(
    readonly dir: string,
    readonly port: number,
    private readonly serverEnv: Record<string, string>,
  ) {}

  static async create(options: StackOptions = {}): Promise<Stack> {
    const dir = mkdtempSync(resolve(tmpdir(), "jarvis-e2e-"));
    mkdirSync(resolve(dir, "home"));
    return new Stack(dir, await freePort(), options.serverEnv ?? {});
  }

  get dataDir(): string {
    return resolve(this.dir, "data");
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  get logs(): string {
    return `${this.server?.logs() ?? ""}${this.worker?.logs() ?? ""}`;
  }

  private baseEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: resolve(this.dir, "home"),
      NODE_ENV: "test",
      DATA_DIR: this.dataDir,
      LOG_LEVEL: "info",
    };
  }

  async startServer(): Promise<void> {
    const env = {
      ...this.baseEnv(),
      HOST: "127.0.0.1",
      PORT: String(this.port),
      PUBLIC_ORIGIN,
      ASSISTANT_DIR: resolve(repoRoot, "assistant"),
      OWNER_PASSWORD_HASH: syntheticPasswordHash(OWNER_PASSWORD),
      RUNTIME: "scripted",
      STT_PROVIDER: "fixture",
      TTS_PROVIDER: "fixture",
      ...this.serverEnv,
    };
    this.server = manage(spawn(process.execPath, [resolve(serverDist, "main.js")], { env, cwd: this.dir, stdio: ["ignore", "pipe", "pipe"] }));
    await this.waitForHealth();
  }

  async startWorker(): Promise<void> {
    const env = {
      ...this.baseEnv(),
      WORKER_POLL_SECONDS: "1",
      WORKER_HEARTBEAT_FILE: resolve(this.dir, "worker-heartbeat"),
    };
    this.worker = manage(spawn(process.execPath, [resolve(serverDist, "worker.js")], { env, cwd: this.dir, stdio: ["ignore", "pipe", "pipe"] }));
    await waitUntil(() => this.worker?.logs().includes("worker started") ?? false, "worker did not start");
  }

  async stopAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all([this.server?.stop(signal), this.worker?.stop(signal)]);
  }

  async cleanup(): Promise<void> {
    await this.stopAll("SIGKILL");
    this.database?.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async waitForHealth(): Promise<void> {
    await waitUntil(async () => {
      try {
        return (await fetch(`${this.baseUrl}/healthz`)).ok;
      } catch {
        return false;
      }
    }, "server did not become healthy");
  }

  async login(password = OWNER_PASSWORD): Promise<Response> {
    return fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ password }),
    });
  }

  async sessionCookie(): Promise<string> {
    if (this.cookie) return this.cookie;
    const response = await this.login();
    const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    if (!response.ok || !cookie) throw new Error(`login failed with status ${response.status}`);
    this.cookie = cookie;
    return cookie;
  }

  async connect(): Promise<E2eClient> {
    return E2eClient.connect(this.wsUrl, { origin: PUBLIC_ORIGIN, cookie: await this.sessionCookie() });
  }

  private get db(): Database.Database {
    this.database ??= new Database(resolve(this.dataDir, "jarvis.db"));
    return this.database;
  }

  rows<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  execute(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  insertReminder(text: string, dueAt: Date): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.execute(
      `INSERT INTO reminders (id, text, due_utc, timezone, status, created_at, updated_at)
       VALUES (?, ?, ?, 'America/Argentina/Buenos_Aires', 'scheduled', ?, ?)`,
      id,
      text,
      dueAt.toISOString(),
      now,
      now,
    );
    return id;
  }

  insertMemory(content: string): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.execute(
      `INSERT INTO memories (id, content, category, status, source_type, created_at, updated_at)
       VALUES (?, ?, 'preference', 'active', 'owner_statement', ?, ?)`,
      id,
      content,
      now,
      now,
    );
    return id;
  }
}

export async function waitUntil(check: () => boolean | Promise<boolean>, failure: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  throw new Error(failure);
}
