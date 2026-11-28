import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHECK_EVERY_MS = 30_000;
const FAILURES_BEFORE_HEAL = 3;
const READY_AFTER_RESTART_MS = 45_000;
const READY_AFTER_RENEW_MS = 60_000;
const RENEW_GAP_MS = 5 * 60_000;
/**
 * WARP endpoints by IPv4 address. The profile names engage.cloudflareclient.com, which also
 * resolves to IPv6; the server has no IPv6 route, and when wireproxy picked that address the
 * handshake never completed (9 hours on 2026-11-27). Each restart moves to the next one.
 */
export const ENDPOINTS = ["162.159.192.1:2408", "162.159.193.1:2408", "162.159.192.1:500", "162.159.192.1:1701", "162.159.192.1:4500"];

/** The WireGuard profile with its peer endpoint replaced. */
export function withEndpoint(profile: string, endpoint: string): string {
  return /^Endpoint\s*=.*$/m.test(profile) ? profile.replace(/^Endpoint\s*=.*$/m, `Endpoint = ${endpoint}`) : profile.replace(/^\[Peer\]\s*$/m, `[Peer]\nEndpoint = ${endpoint}`);
}

/** The wireproxy config pointed at another WireGuard profile. */
export function withProfile(config: string, profilePath: string): string {
  return config.replace(/^WGConfig\s*=.*$/m, `WGConfig = ${profilePath}`);
}

export interface WarpSupervisorOptions {
  /** Folder with wireproxy.conf, the WARP profile and the account; writable, so the identity can be renewed. */
  dir: string;
  /** Writable folder for the config wireproxy actually runs with. */
  runDir: string;
  wireproxy: string;
  wgcf: string;
  socksPort: number;
  controlPort: number;
  /** Whether traffic gets through the tunnel; defaults to a Cloudflare trace through the local SOCKS port. */
  probe?: () => Promise<boolean>;
  now?: () => number;
  /** How often a restarted tunnel is probed until it is ready. */
  pollMs?: number;
  log?: (event: string) => void;
}

/** Whether a Cloudflare trace says the request went out through WARP. */
export function warpOn(trace: string): boolean {
  return /^warp=(on|plus)$/m.test(trace);
}

/** Length of a SOCKS5 CONNECT reply, or undefined until enough bytes arrived to know it. */
function replyLength(reply: Buffer): number | undefined {
  if (reply.length < 5) return undefined;
  const type = reply[3];
  if (type === 1) return 10;
  if (type === 4) return 22;
  if (type === 3) return 7 + (reply[4] ?? 0);
  return 0;
}

/** Asks Cloudflare's trace page, through the SOCKS proxy on `port`, whether traffic leaves through WARP. */
export function probeThroughSocks(port: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let stage: "greeting" | "connect" | "http" = "greeting";
    let data = Buffer.alloc(0);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("end", () => finish(stage === "http" && warpOn(data.toString("utf8"))));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (stage === "greeting") {
        if (data.length < 2) return;
        if (data[0] !== 5 || data[1] !== 0) return finish(false);
        data = data.subarray(2);
        stage = "connect";
        socket.write(Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 80]));
      }
      if (stage === "connect") {
        const length = replyLength(data);
        if (length === undefined || data.length < length) return;
        if (length === 0 || data[1] !== 0) return finish(false);
        data = data.subarray(length);
        stage = "http";
        socket.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n");
      }
      if (stage === "http" && warpOn(data.toString("utf8"))) finish(true);
    });
  });
}

/**
 * Keeps the WARP tunnel up without an admin: runs wireproxy, checks every 30 seconds that traffic
 * goes through, restarts it after three failed checks and registers a new identity when a restart
 * is not enough. The server asks for the same over HTTP (`POST /restart`, `POST /renew`) when a
 * download finds the tunnel dead or blocked; one heal runs at a time and others wait for it.
 */
export class WarpSupervisor {
  private child: ChildProcess | undefined;
  private stopping = false;
  private failures = 0;
  private healing: Promise<boolean> | undefined;
  private lastRenew = Number.NEGATIVE_INFINITY;
  private endpoint = 0;
  private timer: NodeJS.Timeout | undefined;
  private server: Server | undefined;

  constructor(private readonly options: WarpSupervisorOptions) {}

  start(): void {
    this.spawnProxy();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.server = createServer((request, response) => {
      const how = request.url?.slice(1);
      const respond = (ok: boolean) => {
        response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ready: ok }));
      };
      if (request.method === "POST" && (how === "restart" || how === "renew")) return void this.heal(how).then(respond);
      if (request.method === "GET" && how === "health") return void this.probe().then(respond);
      response.writeHead(404).end();
    });
    this.server.listen(this.options.controlPort, "0.0.0.0");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.server?.close();
    this.child?.kill("SIGTERM");
  }

  /** Brings the tunnel back; `renew` also takes a new identity, at most every five minutes. */
  heal(how: "restart" | "renew"): Promise<boolean> {
    this.healing ??= this.doHeal(how).finally(() => {
      this.healing = undefined;
      this.failures = 0;
    });
    return this.healing;
  }

  private async doHeal(how: "restart" | "renew"): Promise<boolean> {
    const renewAllowed = this.now() - this.lastRenew >= RENEW_GAP_MS;
    if (how === "restart" || !renewAllowed) {
      this.log(`warp: ${how === "restart" ? "restarting the tunnel" : "identity renewed moments ago, restarting instead"}`);
      if (await this.restart(READY_AFTER_RESTART_MS)) return true;
      if (!renewAllowed) return false;
    }
    this.log("warp: registering a new identity");
    try {
      await this.renew();
    } catch {
      this.log("warp: could not register a new identity");
      return this.restart(READY_AFTER_RESTART_MS);
    }
    this.lastRenew = this.now();
    return this.restart(READY_AFTER_RENEW_MS);
  }

  private async check(): Promise<void> {
    if (this.healing || this.stopping) return;
    this.failures = (await this.probe()) ? 0 : this.failures + 1;
    if (this.failures >= FAILURES_BEFORE_HEAL) await this.heal("restart");
  }

  private probe(): Promise<boolean> {
    return (this.options.probe ?? (() => probeThroughSocks(this.options.socksPort)))();
  }

  private async restart(readyWithinMs: number): Promise<boolean> {
    this.endpoint = (this.endpoint + 1) % ENDPOINTS.length;
    const old = this.child;
    this.child = undefined;
    if (old) {
      await new Promise<void>((resolve) => {
        old.once("exit", () => resolve());
        old.kill("SIGTERM");
        setTimeout(resolve, 5_000);
      });
    }
    this.spawnProxy();
    const deadline = this.now() + readyWithinMs;
    while (this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 3_000));
      if (await this.probe()) {
        this.log("warp: tunnel ready");
        return true;
      }
    }
    this.log("warp: tunnel still down");
    return false;
  }

  private async renew(): Promise<void> {
    const { dir, wgcf } = this.options;
    const work = mkdtempSync(join(dir, ".renew-"));
    try {
      await run(wgcf, ["register", "--accept-tos"], { cwd: work, timeout: 60_000 });
      await run(wgcf, ["generate"], { cwd: work, timeout: 60_000 });
      renameSync(join(work, "wgcf-account.toml"), join(dir, "wgcf-account.toml"));
      renameSync(join(work, "wgcf-profile.conf"), join(dir, "wgcf-profile.conf"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Writes the config wireproxy runs with: the stored profile, aimed at the current IPv4 endpoint. */
  private runtimeConfig(): string {
    const { dir, runDir } = this.options;
    mkdirSync(runDir, { recursive: true });
    const profile = join(runDir, "profile.conf");
    const config = join(runDir, "wireproxy.conf");
    writeFileSync(profile, withEndpoint(readFileSync(join(dir, "wgcf-profile.conf"), "utf8"), ENDPOINTS[this.endpoint] ?? ENDPOINTS[0]!), { mode: 0o600 });
    writeFileSync(config, withProfile(readFileSync(join(dir, "wireproxy.conf"), "utf8"), profile), { mode: 0o600 });
    this.log(`warp: using endpoint ${ENDPOINTS[this.endpoint]}`);
    return config;
  }

  private spawnProxy(): void {
    if (this.stopping) return;
    const child = spawn(this.options.wireproxy, ["-c", this.runtimeConfig()], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", () => this.log("warp: wireproxy could not start"));
    child.on("exit", () => {
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      setTimeout(() => {
        if (!this.child) this.spawnProxy();
      }, 2_000);
    });
    this.child = child;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(event: string): void {
    (this.options.log ?? ((line: string) => console.warn(JSON.stringify({ time: new Date().toISOString(), msg: line }))))(event);
  }
}
