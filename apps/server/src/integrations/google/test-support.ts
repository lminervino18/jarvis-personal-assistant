import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GmailAccountLabel } from "@jarvis/contracts";
import { TokenCipher } from "../../crypto/token-cipher.js";
import { openMigratedDatabase } from "../../db/database.js";
import { GmailClient } from "../gmail/client.js";
import { GmailService } from "../gmail/gmail-service.js";
import { GoogleAccessTokens } from "./access-tokens.js";
import { GoogleAccountStore } from "./account-store.js";
import { GoogleConnector } from "./connector.js";
import { GoogleOAuthClient } from "./oauth-client.js";
import { OAuthStateStore } from "./oauth-states.js";

export const CLIENT_ID = "client-id.example.test";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const FIXED_NOW = new Date("2026-10-24T15:00:00Z");

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/synthetic/${name}`, import.meta.url), "utf8")) as T;
}

export function makeIdToken(email: string, overrides: Record<string, unknown> = {}): string {
  const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, email, email_verified: true, ...overrides };
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

export function makeDatabase() {
  return { db: openMigratedDatabase(":memory:"), cipher: new TokenCipher(randomBytes(32)) };
}

interface SearchFixture {
  list: unknown;
  metadata: Record<string, unknown>;
}

export interface GrantResponse {
  email: string;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

/** In-process stand-in for Google's OAuth and Gmail endpoints. No network access. */
export class FakeGoogle {
  readonly calls: { method: string; url: string; body: string }[] = [];
  grant: GrantResponse = { email: "loren.prueba@example.test" };
  refreshFails = false;
  accessToken = "access-1";
  threads = new Map<string, unknown>();
  search = loadFixture<SearchFixture>("gmail/search.json");
  gmailStatus?: number;
  staleTokens = new Set<string>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    this.calls.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return this.token(body);
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    return this.gmail(url, new Headers(init?.headers).get("authorization") ?? "");
  };

  private token(body: string): Response {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshFails) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: this.accessToken, expires_in: 3600 });
    }
    const { email, refreshToken, scope, idToken } = this.grant;
    return json({
      access_token: this.accessToken,
      expires_in: 3600,
      refresh_token: refreshToken ?? `refresh-${email}`,
      scope: scope ?? `openid email ${GMAIL_SCOPE}`,
      id_token: idToken ?? makeIdToken(email),
    });
  }

  private gmail(url: string, authorization: string): Response {
    const path = new URL(url).pathname.replace("/gmail/v1/users/me", "");
    if (this.staleTokens.has(authorization.replace("Bearer ", ""))) return json({ error: { code: 401 } }, 401);
    if (this.gmailStatus) return json({ error: { errors: [{ reason: "backendError" }] } }, this.gmailStatus);
    if (path === "/messages") return json(this.search.list);
    const message = path.startsWith("/messages/") ? this.search.metadata[path.slice("/messages/".length)] : undefined;
    if (message) return json(message);
    const thread = path.startsWith("/threads/") ? this.threads.get(path.slice("/threads/".length)) : undefined;
    return thread ? json(thread) : json({ error: { code: 404 } }, 404);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function buildGoogleHarness(now: () => Date = () => FIXED_NOW) {
  const { db, cipher } = makeDatabase();
  const fake = new FakeGoogle();
  const oauth = new GoogleOAuthClient(
    { clientId: CLIENT_ID, clientSecret: "secret.example.test", redirectUri: "http://localhost:5173/api/integrations/google/callback" },
    fake.fetch,
  );
  const accounts = new GoogleAccountStore(db, cipher);
  const states = new OAuthStateStore(db, cipher);
  const tokens = new GoogleAccessTokens(accounts, oauth, now);
  const connector = new GoogleConnector(oauth, states, accounts, tokens, now);
  const gmail = new GmailService(accounts, new GmailClient(tokens, "America/Argentina/Buenos_Aires", fake.fetch));

  async function connect(label: GmailAccountLabel, email: string, grant: Partial<GrantResponse> = {}) {
    fake.grant = { email, ...grant };
    const state = new URL(connector.authorizationUrl(label)).searchParams.get("state") as string;
    return connector.complete("auth-code.example.test", state);
  }

  return { db, cipher, fake, oauth, accounts, states, tokens, connector, gmail, connect };
}
