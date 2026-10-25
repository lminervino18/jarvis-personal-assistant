import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ConnectError } from "./connector.js";
import { createPkcePair } from "./oauth-client.js";
import { registerGoogleRoutes } from "./routes.js";
import { buildGoogleHarness, makeIdToken } from "./test-support.js";

const PERSONAL = "loren.prueba@example.test";
const WORK = "loren.trabajo@example.test";

async function expectConnectFailure(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toMatchObject({ reason });
  await promise.catch((error) => expect(error).toBeInstanceOf(ConnectError));
}

describe("google oauth", () => {
  it("builds a PKCE authorization URL for offline read-only access", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));

    const { connector } = buildGoogleHarness();
    const url = new URL(connector.authorizationUrl("personal"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the hash of the state and accepts it exactly once", () => {
    const { db, states } = buildGoogleHarness();
    const { state } = states.start("personal", new Date("2026-10-24T15:00:00Z"));
    const rows = db.prepare("SELECT * FROM oauth_states").all() as { state_hash: string; verifier_ciphertext: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(state);
    expect(rows[0]?.state_hash).toBe(createHash("sha256").update(state).digest("hex"));

    expect(states.consume(`${state}x`, new Date("2026-10-24T15:01:00Z"))).toBeUndefined();
    expect(states.consume(state, new Date("2026-10-24T15:01:00Z"))).toMatchObject({ label: "personal" });
    expect(states.consume(state, new Date("2026-10-24T15:01:00Z"))).toBeUndefined();
  });

  it("rejects an expired state and cleans old ones", () => {
    const { db, states } = buildGoogleHarness();
    const { state } = states.start("work", new Date("2026-10-24T15:00:00Z"));
    expect(states.consume(state, new Date("2026-10-24T15:10:01Z"))).toBeUndefined();

    states.start("work", new Date("2026-10-24T15:00:00Z"));
    states.start("personal", new Date("2026-10-24T16:00:00Z"));
    expect(db.prepare("SELECT count(*) AS n FROM oauth_states").get()).toEqual({ n: 1 });
  });

  it("rejects a callback with an unknown state without calling Google", async () => {
    const { connector, fake } = buildGoogleHarness();
    await expectConnectFailure(connector.complete("code", "forged-state"), "invalid_state");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("google accounts", () => {
  it("binds each label to the real email and encrypts the refresh token", async () => {
    const { connect, accounts, db, fake } = buildGoogleHarness();
    const account = await connect("personal", PERSONAL);
    expect(account).toMatchObject({ label: "personal", email: PERSONAL, status: "connected" });
    expect(account.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");

    const row = db.prepare("SELECT token_ciphertext FROM oauth_accounts").get() as { token_ciphertext: string };
    expect(row.token_ciphertext).toMatch(/^v1\./);
    expect(row.token_ciphertext).not.toContain(`refresh-${PERSONAL}`);
    expect(accounts.refreshToken("personal")).toBe(`refresh-${PERSONAL}`);
    expect(fake.calls[0]?.body).toContain("code_verifier=");
  });

  it("refuses a label bound to another email and an email under the other label", async () => {
    const { connect, accounts } = buildGoogleHarness();
    await connect("personal", PERSONAL);
    await expectConnectFailure(connect("personal", WORK), "label_bound");
    await expectConnectFailure(connect("work", PERSONAL), "email_bound");
    expect(accounts.get("personal")?.email).toBe(PERSONAL);
    expect(accounts.get("work")).toBeUndefined();

    await connect("work", WORK);
    expect(accounts.list().map((account) => account.email)).toEqual([PERSONAL, WORK]);
    await connect("personal", PERSONAL);
    expect(accounts.get("personal")?.status).toBe("connected");
  });

  it("refuses grants without Gmail scope, refresh token or a trusted identity", async () => {
    const { connect, accounts } = buildGoogleHarness();
    await expectConnectFailure(connect("personal", PERSONAL, { scope: "openid email" }), "scope_missing");
    await expectConnectFailure(connect("personal", PERSONAL, { idToken: makeIdToken(PERSONAL, { aud: "other-client" }) }), "identity_rejected");
    await expectConnectFailure(connect("personal", PERSONAL, { idToken: makeIdToken(PERSONAL, { email_verified: false }) }), "identity_rejected");
    await expectConnectFailure(connect("personal", PERSONAL, { idToken: "not-a-jwt" }), "identity_rejected");
    expect(accounts.list()).toEqual([]);
  });

  it("marks the account expired on invalid_grant", async () => {
    const { connect, accounts, tokens, fake } = buildGoogleHarness();
    await connect("personal", PERSONAL);
    fake.refreshFails = true;
    await expect(tokens.get("personal")).rejects.toMatchObject({ code: "auth_expired", account: "personal" });
    expect(accounts.get("personal")).toMatchObject({ status: "expired", lastError: "invalid_grant" });
    await expect(tokens.get("personal")).rejects.toMatchObject({ code: "auth_expired" });
  });

  it("revokes, wipes the token and lets the label be rebound afterwards", async () => {
    const { connect, connector, accounts, tokens, fake, db } = buildGoogleHarness();
    await connect("personal", PERSONAL);
    expect(await connector.revoke("personal")).toEqual({ remoteRevoked: true });
    expect(fake.calls.at(-1)?.url).toContain("oauth2.googleapis.com/revoke");
    expect(accounts.get("personal")?.status).toBe("revoked");
    expect(db.prepare("SELECT token_ciphertext FROM oauth_accounts").get()).toEqual({ token_ciphertext: "" });
    await expect(tokens.get("personal")).rejects.toMatchObject({ code: "revoked" });
    expect(await connector.revoke("work")).toBeUndefined();

    await connect("personal", WORK);
    expect(accounts.get("personal")).toMatchObject({ email: WORK, status: "connected" });
  });

  it("rewraps tokens sealed with a previous key", async () => {
    const { accounts, connect, cipher, db } = buildGoogleHarness();
    await connect("personal", PERSONAL);
    expect(accounts.rewrapTokens()).toBe(0);
    const before = (db.prepare("SELECT token_ciphertext FROM oauth_accounts").get() as { token_ciphertext: string }).token_ciphertext;
    expect(cipher.isCurrent(before)).toBe(true);
  });
});

describe("google routes", () => {
  async function build() {
    const harness = buildGoogleHarness();
    const app = Fastify();
    registerGoogleRoutes(app, { requireOwner: (request) => request.headers["x-owner"] === "1" }, {
      connector: harness.connector,
      publicOrigin: "http://localhost:5173",
    });
    return { app, ...harness };
  }

  it("requires the owner session to start and revoke", async () => {
    const { app } = await build();
    expect((await app.inject({ url: "/api/integrations/google/start?label=personal" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/integrations/google/revoke", payload: { label: "personal" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/integrations/google/start?label=other", headers: { "x-owner": "1" } })).statusCode).toBe(400);
  });

  it("redirects to Google, completes the callback and reports failures without leaking details", async () => {
    const { app, accounts, fake } = await build();
    const start = await app.inject({ url: "/api/integrations/google/start?label=work", headers: { "x-owner": "1" } });
    expect(start.statusCode).toBe(302);
    const authorization = new URL(start.headers.location as string);
    expect(authorization.host).toBe("accounts.google.com");

    fake.grant = { email: WORK };
    const state = authorization.searchParams.get("state") as string;
    const done = await app.inject({ url: `/api/integrations/google/callback?code=abc&state=${state}` });
    expect(done.headers.location).toBe("http://localhost:5173/?integration=gmail&status=connected&label=work");
    expect(accounts.get("work")?.email).toBe(WORK);

    const replay = await app.inject({ url: `/api/integrations/google/callback?code=abc&state=${state}` });
    expect(replay.headers.location).toBe("http://localhost:5173/?integration=gmail&status=error&reason=invalid_state");
    const denied = await app.inject({ url: `/api/integrations/google/callback?error=access_denied&state=${state}` });
    expect(denied.headers.location).toContain("reason=denied");
  });

  it("revokes through the API", async () => {
    const { app, connect } = await build();
    await connect("personal", PERSONAL);
    const response = await app.inject({ method: "POST", url: "/api/integrations/google/revoke", headers: { "x-owner": "1" }, payload: { label: "personal" } });
    expect(response.json()).toEqual({ revoked: true, remoteRevoked: true });
    const missing = await app.inject({ method: "POST", url: "/api/integrations/google/revoke", headers: { "x-owner": "1" }, payload: { label: "work" } });
    expect(missing.statusCode).toBe(404);
  });
});
