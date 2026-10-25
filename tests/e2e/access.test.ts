import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_PASSWORD, PUBLIC_ORIGIN, Stack } from "./support/stack.js";
import { upgradeStatus } from "./support/ws-client.js";

const ATTACKER_ORIGIN = "http://attacker.example";

describe("access control on the real server", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await Stack.create();
    await stack.startServer();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("reports anonymous visitors as unauthenticated and hides owner-only routes", async () => {
    const session = await fetch(`${stack.baseUrl}/api/auth/session`);
    expect(await session.json()).toEqual({ authenticated: false });

    const context = await fetch(`${stack.baseUrl}/api/health/context`);
    expect(context.status).toBe(401);
  });

  it("refuses WebSocket upgrades without a valid session cookie", async () => {
    expect(await upgradeStatus(stack.wsUrl, { origin: PUBLIC_ORIGIN })).toBe(401);
    expect(await upgradeStatus(stack.wsUrl, { origin: PUBLIC_ORIGIN, cookie: "jarvis_session=forged" })).toBe(401);
  });

  it("refuses logins from a foreign origin and wrong passwords", async () => {
    const foreign = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ATTACKER_ORIGIN },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(foreign.status).toBe(403);

    const wrong = await stack.login("not-the-owner-password");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  it("issues an HttpOnly SameSite=Strict cookie for the right password", async () => {
    const response = await stack.login();
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()[0] ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(OWNER_PASSWORD);
  });

  it("refuses WebSocket upgrades with a valid cookie but a foreign or missing origin", async () => {
    const cookie = await stack.sessionCookie();
    expect(await upgradeStatus(stack.wsUrl, { origin: ATTACKER_ORIGIN, cookie })).toBe(403);
    expect(await upgradeStatus(stack.wsUrl, { cookie })).toBe(403);
    expect(await upgradeStatus(stack.wsUrl, { origin: PUBLIC_ORIGIN, cookie })).toBe(101);
  });

  it("refuses the old cookie after logout", async () => {
    const cookie = await stack.sessionCookie();
    const logout = await fetch(`${stack.baseUrl}/api/auth/logout`, { method: "POST", headers: { origin: PUBLIC_ORIGIN, cookie } });
    expect(logout.status).toBe(200);
    expect(await upgradeStatus(stack.wsUrl, { origin: PUBLIC_ORIGIN, cookie })).toBe(401);
    const session = await fetch(`${stack.baseUrl}/api/auth/session`, { headers: { cookie } });
    expect(await session.json()).toEqual({ authenticated: false });
  });
});
