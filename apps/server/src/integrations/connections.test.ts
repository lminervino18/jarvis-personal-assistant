import { createHash, randomBytes } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "../crypto/token-cipher.js";
import { openMigratedDatabase } from "../db/database.js";
import { createConnections } from "./connections.js";

const ORIGIN = "https://jarvis.example.test";
const GITHUB_TOKEN = "gho_synthetic_token_value";
const VERCEL_TOKEN = "vercel_synthetic_token_value";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(scope = "repo") {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: GITHUB_TOKEN, scope, token_type: "bearer" });
    if (url === "https://api.github.com/user") return json({ login: "owner-login" });
    if (url === "https://api.vercel.com/v2/user") return json({ user: { username: "owner-vercel" } });
    if (url === "https://api.vercel.com/v2/teams") return json({ teams: [{ id: "team_other", slug: "other" }, { id: "team_owner", slug: "owner" }] });
    if (url.startsWith("https://api.vercel.com/v6/domains/example.test")) return url.includes("team_owner") ? json({ domain: {} }) : json({}, 404);
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function setup(scope?: string) {
  const db = openMigratedDatabase(":memory:");
  const { fetchFn, calls } = fakeFetch(scope);
  const env = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", PROJECTS_DOMAIN: "example.test" };
  const connections = createConnections({ db, env, cipher: new TokenCipher(randomBytes(32)), publicOrigin: ORIGIN, fetchFn });
  const app = Fastify();
  connections.registerRoutes(app, { requireOwner: () => true });
  await app.ready();
  return { app, db, calls, connections };
}

async function authorize(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const start = await app.inject({ method: "GET", url: "/api/integrations/github/start" });
  const target = new URL(start.headers.location as string);
  return { start, target, state: target.searchParams.get("state") as string };
}

describe("GitHub connection", () => {
  it("connects through GitHub's OAuth flow with PKCE and keeps the token encrypted", async () => {
    const { app, db, calls, connections } = await setup();
    const { start, target, state } = await authorize(app);
    expect(start.statusCode).toBe(302);
    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ client_id: "client-id", scope: "repo", redirect_uri: `${ORIGIN}/api/integrations/github/callback`, code_challenge_method: "S256" });

    const callback = await app.inject({ method: "GET", url: `/api/integrations/github/callback?code=abc&state=${state}` });
    expect(callback.headers.location).toBe(`${ORIGIN}/?integration=github&status=connected&label=owner-login`);
    const exchange = JSON.parse(String(calls.find((call) => call.url.endsWith("/access_token"))?.init?.body));
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(target.searchParams.get("code_challenge"));
    expect(connections.accounts?.token("github")).toBe(GITHUB_TOKEN);
    expect(JSON.stringify(db.prepare("SELECT * FROM service_accounts").all())).not.toContain(GITHUB_TOKEN);

    const again = await app.inject({ method: "GET", url: `/api/integrations/github/callback?code=abc&state=${state}` });
    expect(again.headers.location).toContain("reason=invalid_state");
  });

  it("refuses a token that cannot write to repositories", async () => {
    const { app, connections } = await setup("read:user");
    const { state } = await authorize(app);
    const callback = await app.inject({ method: "GET", url: `/api/integrations/github/callback?code=abc&state=${state}` });
    expect(callback.headers.location).toContain("status=error");
    expect(connections.accounts?.get("github")).toBeUndefined();
  });

  it("reports GitHub as not configured without the app's client settings", async () => {
    const db = openMigratedDatabase(":memory:");
    const connections = createConnections({ db, env: {}, cipher: new TokenCipher(randomBytes(32)), publicOrigin: ORIGIN });
    expect((await connections.statusSource.status())[0]).toMatchObject({ provider: "github", status: "disabled" });
  });
});

describe("Vercel connection", () => {
  it("checks a pasted token, finds the team that owns the projects domain and can be disconnected", async () => {
    const { app, connections } = await setup();
    const saved = await app.inject({ method: "POST", url: "/api/integrations/vercel/token", payload: { token: VERCEL_TOKEN } });
    expect(saved.json()).toEqual({ account: "owner-vercel", domain: "example.test" });
    expect(connections.accounts?.get("vercel")).toMatchObject({ account: "owner-vercel", detail: "team_owner" });

    const listed = await app.inject({ method: "GET", url: "/api/connections" });
    expect(listed.json()).toEqual({ github: { available: true, account: null }, vercel: { available: true, account: "owner-vercel", domain: "example.test" } });

    const removed = await app.inject({ method: "POST", url: "/api/integrations/vercel/disconnect" });
    expect(removed.json()).toEqual({ disconnected: true });
    expect(connections.accounts?.token("vercel")).toBeUndefined();
  });
});
