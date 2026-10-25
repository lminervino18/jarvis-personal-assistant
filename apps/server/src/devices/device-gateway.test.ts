import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { OWNER_ORIGIN, startDeviceTestServer } from "./test-server.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
  const server = await startDeviceTestServer();
  cleanups.push(() => server.close());
  return server;
}

function post(url: string, init: { cookie?: string; origin?: string; body?: unknown }) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
  });
}

function connect(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve({ socket, status: 101 }));
    socket.once("unexpected-response", (_request, response) => resolve({ socket, status: response.statusCode ?? 0 }));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<{ type: string; [key: string]: unknown }> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

describe("device pairing routes", () => {
  it("requires the owner session to create, list and revoke devices", async () => {
    const server = await start();
    const created = await post(`${server.httpUrl}/api/devices`, { origin: OWNER_ORIGIN, body: { name: "Escritorio" } });
    expect(created.status).toBe(401);
    expect((await fetch(`${server.httpUrl}/api/devices`)).status).toBe(401);
    expect((await post(`${server.httpUrl}/api/devices/${crypto.randomUUID()}/revoke`, { origin: OWNER_ORIGIN })).status).toBe(401);
    expect(server.devices.list()).toHaveLength(0);
  });

  it("shows the token once and never again", async () => {
    const server = await start();
    const cookie = await server.ownerCookie();
    const created = await post(`${server.httpUrl}/api/devices`, { cookie, origin: OWNER_ORIGIN, body: { name: "Escritorio" } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; name: string; token: string };
    expect(body.token.length).toBeGreaterThanOrEqual(43);
    const listed = await fetch(`${server.httpUrl}/api/devices`, { headers: { cookie } });
    const text = await listed.text();
    expect(text).toContain(body.id);
    expect(text).not.toContain(body.token);
    expect(text).not.toContain("token_hash");
  });

  it("rejects creation from a foreign origin and invalid names", async () => {
    const server = await start();
    const cookie = await server.ownerCookie();
    expect((await post(`${server.httpUrl}/api/devices`, { cookie, origin: "https://evil.example", body: { name: "x" } })).status).toBe(403);
    expect((await post(`${server.httpUrl}/api/devices`, { cookie, origin: OWNER_ORIGIN, body: { name: "  " } })).status).toBe(400);
    expect(server.devices.list()).toHaveLength(0);
  });

  it("answers 404 when revoking an unknown device", async () => {
    const server = await start();
    const cookie = await server.ownerCookie();
    expect((await post(`${server.httpUrl}/api/devices/${crypto.randomUUID()}/revoke`, { cookie, origin: OWNER_ORIGIN })).status).toBe(404);
    expect((await post(`${server.httpUrl}/api/devices/nope/revoke`, { cookie, origin: OWNER_ORIGIN })).status).toBe(404);
  });
});

describe("GET /ws/device", () => {
  it("accepts a valid bearer token without Origin and speaks the shared protocol", async () => {
    const server = await start();
    const { token, device } = server.devices.create("Escritorio");
    const { socket, status } = await connect(server.wsUrl, { authorization: `Bearer ${token}` });
    cleanups.push(() => socket.close());
    expect(status).toBe(101);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: 1, client: { kind: "device", version: "test" }, audio: { input: [], output: [{ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }] } }));
    expect(await ready).toMatchObject({ type: "ready", capabilities: { stt: true, tts: true, outputFormat: { sampleRate: 16000 } } });
    expect(server.devices.list().find((d) => d.id === device.id)?.lastSeenAt).not.toBeNull();
  });

  it("rejects missing, malformed, unknown and revoked tokens", async () => {
    const server = await start();
    const { token, device } = server.devices.create("Escritorio");
    expect((await connect(server.wsUrl, {})).status).toBe(401);
    expect((await connect(server.wsUrl, { authorization: token })).status).toBe(401);
    expect((await connect(server.wsUrl, { authorization: "Bearer nope" })).status).toBe(401);
    server.devices.revoke(device.id);
    expect((await connect(server.wsUrl, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("never accepts the owner session cookie as device authentication", async () => {
    const server = await start();
    const cookie = await server.ownerCookie();
    expect((await connect(server.wsUrl, { cookie, origin: OWNER_ORIGIN })).status).toBe(401);
  });

  it("closes the open socket as soon as the owner revokes the device", async () => {
    const server = await start();
    const cookie = await server.ownerCookie();
    const { token, device } = server.devices.create("Escritorio");
    const { socket } = await connect(server.wsUrl, { authorization: `Bearer ${token}` });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    const response = await post(`${server.httpUrl}/api/devices/${device.id}/revoke`, { cookie, origin: OWNER_ORIGIN });
    expect(response.status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await connect(server.wsUrl, { authorization: `Bearer ${token}` })).status).toBe(401);
  });
});
