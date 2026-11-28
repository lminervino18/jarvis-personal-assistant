import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answered, ENDPOINTS, probeThroughSocks, WarpSupervisor, withEndpoint, withProfile } from "./warp-supervisor.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-warp-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeSocks(answer: string): Promise<number> {
  const server: Server = createServer((socket) => {
    let stage = 0;
    socket.on("data", () => {
      if (stage === 0) socket.write(Buffer.from([5, 0]));
      else if (stage === 1) socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      else socket.end(answer);
      stage++;
    });
  });
  cleanup.push(() => server.close());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("the WARP tunnel check", () => {
  it("takes any HTTP answer through the tunnel as a live tunnel", () => {
    expect(answered("HTTP/1.1 301 Moved Permanently\r\nServer: cloudflare\r\n")).toBe(true);
    expect(answered("HTTP/1.1 200 OK\r\n\r\nwarp=on")).toBe(true);
    expect(answered("")).toBe(false);
    expect(answered("SSH-2.0-OpenSSH")).toBe(false);
  });

  it("aims the profile at an IPv4 endpoint, since the server has no IPv6 route", () => {
    const profile = "[Interface]\nPrivateKey = k\n[Peer]\nPublicKey = p\nEndpoint = engage.cloudflareclient.com:2408\n";
    expect(withEndpoint(profile, "162.159.192.1:500")).toContain("Endpoint = 162.159.192.1:500");
    expect(withEndpoint(profile, "162.159.192.1:500")).not.toContain("engage");
    expect(withEndpoint("[Peer]\nPublicKey = p\n", "162.159.193.1:2408")).toContain("[Peer]\nEndpoint = 162.159.193.1:2408");
    expect(withProfile("WGConfig = /etc/wireproxy/wgcf-profile.conf\n\n[Socks5]\nBindAddress = 0.0.0.0:40000\n", "/var/run/warp/profile.conf")).toBe(
      "WGConfig = /var/run/warp/profile.conf\n\n[Socks5]\nBindAddress = 0.0.0.0:40000\n",
    );
    expect(ENDPOINTS.every((endpoint) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(endpoint))).toBe(true);
  });

  it("asks the trace through the SOCKS proxy", async () => {
    expect(await probeThroughSocks(await fakeSocks("HTTP/1.1 301 Moved Permanently\r\nLocation: https://1.1.1.1/cdn-cgi/trace\r\n\r\n"))).toBe(true);
    expect(await probeThroughSocks(await fakeSocks("garbage"))).toBe(false);
    expect(await probeThroughSocks(1, 500)).toBe(false);
  });
});

describe("the WARP supervisor", () => {
  function setup(probe: (dir: string) => boolean, now?: () => number) {
    const dir = tempDir();
    const bin = tempDir();
    writeFileSync(join(dir, "wireproxy.conf"), "WGConfig = /etc/wireproxy/wgcf-profile.conf\n");
    writeFileSync(join(dir, "wgcf-profile.conf"), "old profile");
    const runDir = join(tempDir(), "run");
    const wireproxy = script(bin, "wireproxy", "exec sleep 30");
    const wgcf = script(bin, "wgcf", `case "$1" in register) echo account > wgcf-account.toml ;; generate) echo new profile > wgcf-profile.conf ;; esac`);
    const events: string[] = [];
    const supervisor = new WarpSupervisor({ dir, runDir, wireproxy, wgcf, socksPort: 1, controlPort: 0, pollMs: 5, probe: async () => probe(dir), log: (event) => events.push(event), ...(now ? { now } : {}) });
    cleanup.push(() => void supervisor.stop());
    return { dir, supervisor, events };
  }

  it("restarts a dead tunnel and stops there when it comes back", async () => {
    let probes = 0;
    const env = setup(() => ++probes > 1);
    expect(await env.supervisor.heal("restart")).toBe(true);
    expect(readFileSync(join(env.dir, "wgcf-profile.conf"), "utf8")).toBe("old profile");
    expect(env.events).toEqual(["warp: restarting the tunnel", `warp: using endpoint ${ENDPOINTS[1]}`, "warp: tunnel ready"]);
  });

  it("registers a new identity when YouTube blocks the current one", async () => {
    const env = setup((dir) => existsSync(join(dir, "wgcf-account.toml")));
    expect(await env.supervisor.heal("renew")).toBe(true);
    expect(readFileSync(join(env.dir, "wgcf-profile.conf"), "utf8")).toBe("new profile\n");
    expect(env.events).toContain("warp: registering a new identity");
  });

  it("runs one heal at a time and renews at most every five minutes", async () => {
    let now = 0;
    const env = setup(
      (dir) => existsSync(join(dir, "wgcf-account.toml")),
      () => (now += 1_000),
    );
    const [first, second] = [env.supervisor.heal("renew"), env.supervisor.heal("renew")];
    expect(first).toBe(second);
    expect(await first).toBe(true);
    rmSync(join(env.dir, "wgcf-account.toml"));
    expect(await env.supervisor.heal("renew")).toBe(false);
    expect(env.events.filter((event) => event === "warp: registering a new identity")).toHaveLength(1);
  });
});
