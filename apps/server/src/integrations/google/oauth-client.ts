import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleAuthFailure = "invalid_grant" | "rejected" | "unavailable";

/** Failure talking to Google's OAuth endpoints. The message never carries tokens or response bodies. */
export class GoogleAuthError extends Error {
  constructor(readonly reason: GoogleAuthFailure) {
    super(`google oauth ${reason}`);
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
  id_token: z.string().optional(),
});

const IdTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  email: z.string().min(3),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
});

export interface GoogleTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  scopes: string[];
  idToken?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function decodeClaims(idToken: string): unknown {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Reads the verified email from an ID token received directly from Google's token endpoint over TLS. */
export function parseIdTokenEmail(idToken: string, clientId: string): string {
  const claims = IdTokenClaims.safeParse(decodeClaims(idToken));
  const trustedIssuer = claims.success && ["https://accounts.google.com", "accounts.google.com"].includes(claims.data.iss);
  if (!claims.success || !trustedIssuer || claims.data.aud !== clientId || String(claims.data.email_verified) === "false") {
    throw new GoogleAuthError("rejected");
  }
  return claims.data.email.toLowerCase();
}

/** Minimal Google OAuth 2.0 web-flow client (authorization code with PKCE) over `fetch`. */
export class GoogleOAuthClient {
  constructor(
    readonly config: GoogleOAuthConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, challenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  exchangeCode(code: string, verifier: string): Promise<GoogleTokens> {
    return this.requestTokens({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.config.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<boolean> {
    try {
      const response = await this.post(REVOKE_URL, { token });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async requestTokens(grant: Record<string, string>): Promise<GoogleTokens> {
    const response = await this.post(TOKEN_URL, {
      ...grant,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const invalidGrant = response.status === 400 && (body as { error?: unknown } | undefined)?.error === "invalid_grant";
      throw new GoogleAuthError(invalidGrant ? "invalid_grant" : response.status >= 500 ? "unavailable" : "rejected");
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new GoogleAuthError("rejected");
    return {
      accessToken: parsed.data.access_token,
      expiresInSeconds: parsed.data.expires_in,
      refreshToken: parsed.data.refresh_token,
      scopes: parsed.data.scope.split(" ").filter(Boolean),
      idToken: parsed.data.id_token,
    };
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleAuthError("unavailable");
    }
  }
}
