import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_ORIGIN, Stack } from "./support/stack.js";
import { upgradeStatus } from "./support/ws-client.js";

const run = promisify(execFile);
const simulatorDir = resolve(import.meta.dirname, "../../tools/device-sim");

describe("the device gateway and simulator against the real server", () => {
  let stack: Stack;
  let deviceId: string;
  let token: string;
  const deviceUrl = () => `ws://127.0.0.1:${stack.port}/ws/device`;

  beforeAll(async () => {
    stack = await Stack.create();
    await stack.startServer();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  async function ownerRequest(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    const headers: Record<string, string> = { origin: PUBLIC_ORIGIN, cookie: await stack.sessionCookie() };
    if (init.body) headers["content-type"] = "application/json";
    return fetch(`${stack.baseUrl}${path}`, { method: init.method, headers, body: init.body ? JSON.stringify(init.body) : undefined });
  }

  it("rejects anonymous pairing and sockets without a known device token", async () => {
    expect((await fetch(`${stack.baseUrl}/api/devices`)).status).toBe(401);
    expect(await upgradeStatus(deviceUrl(), {})).toBe(401);
    expect(await upgradeStatus(deviceUrl(), { authorization: "Bearer not-a-device-token" })).toBe(401);
    expect(await upgradeStatus(deviceUrl(), { cookie: await stack.sessionCookie(), origin: PUBLIC_ORIGIN })).toBe(401);
  });

  it("runs a full 16 kHz voice turn from the simulator CLI and stores the turn", async () => {
    const created = await ownerRequest("/api/devices", { method: "POST", body: { name: "Simulador e2e" } });
    expect(created.status).toBe(201);
    ({ id: deviceId, token } = (await created.json()) as { id: string; token: string });

    const out = resolve(stack.dir, "reply.wav");
    const { stdout } = await run(
      resolve(simulatorDir, "node_modules/.bin/tsx"),
      ["src/cli.ts", "--url", deviceUrl(), "--tone", "1", "--out", out],
      { cwd: simulatorDir, env: { PATH: process.env.PATH ?? "", HOME: stack.dir, JARVIS_DEVICE_TOKEN: token } },
    );
    const result = JSON.parse(stdout) as { status: string; transcript: string; assistantText: string; replyBytes: number };
    expect(result).toMatchObject({ status: "completed", transcript: "Hola, ¿me escuchás?", assistantText: "Recibido: Hola, ¿me escuchás?" });
    expect(result.replyBytes).toBeGreaterThan(0);
    const wav = readFileSync(out);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBeGreaterThan(result.replyBytes);

    const turns = stack.rows<{ input_mode: string; status: string }>("SELECT input_mode, status FROM turns");
    expect(turns).toEqual([{ input_mode: "voice", status: "completed" }]);
  });

  it("refuses the device token once the owner revokes it", async () => {
    expect((await ownerRequest(`/api/devices/${deviceId}/revoke`, { method: "POST" })).status).toBe(200);
    expect(await upgradeStatus(deviceUrl(), { authorization: `Bearer ${token}` })).toBe(401);
    await expect(
      run(resolve(simulatorDir, "node_modules/.bin/tsx"), ["src/cli.ts", "--url", deviceUrl(), "--tone", "1", "--out", resolve(stack.dir, "none.wav")], {
        cwd: simulatorDir,
        env: { PATH: process.env.PATH ?? "", HOME: stack.dir, JARVIS_DEVICE_TOKEN: token },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
