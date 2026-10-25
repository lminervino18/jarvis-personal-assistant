import type { GmailAccountLabel } from "@jarvis/contracts";
import { TokenDecryptionError } from "../../crypto/token-cipher.js";
import { AccountBindingError, type GoogleAccount, type GoogleAccountStore } from "./account-store.js";
import type { GoogleAccessTokens } from "./access-tokens.js";
import { GMAIL_READONLY_SCOPE, GoogleAuthError, parseIdTokenEmail, type GoogleOAuthClient } from "./oauth-client.js";
import type { OAuthStateStore } from "./oauth-states.js";

export type ConnectFailure =
  | "invalid_state"
  | "scope_missing"
  | "no_refresh_token"
  | "identity_rejected"
  | "label_bound"
  | "email_bound"
  | "unavailable";

export class ConnectError extends Error {
  constructor(readonly reason: ConnectFailure) {
    super(`google connect failed: ${reason}`);
  }
}

/** Orchestrates connecting, completing and revoking a Google account for a label. */
export class GoogleConnector {
  constructor(
    private readonly oauth: GoogleOAuthClient,
    private readonly states: OAuthStateStore,
    private readonly accounts: GoogleAccountStore,
    private readonly tokens: GoogleAccessTokens,
    private readonly now: () => Date = () => new Date(),
  ) {}

  authorizationUrl(label: GmailAccountLabel): string {
    const { state, challenge } = this.states.start(label, this.now());
    return this.oauth.authorizationUrl(state, challenge);
  }

  async complete(code: string, state: string): Promise<GoogleAccount> {
    try {
      const pending = this.states.consume(state, this.now());
      if (!pending) throw new ConnectError("invalid_state");
      const tokens = await this.oauth.exchangeCode(code, pending.verifier);
      if (!tokens.scopes.includes(GMAIL_READONLY_SCOPE)) throw new ConnectError("scope_missing");
      if (!tokens.refreshToken) throw new ConnectError("no_refresh_token");
      if (!tokens.idToken) throw new ConnectError("identity_rejected");
      const email = parseIdTokenEmail(tokens.idToken, this.oauth.config.clientId);
      const account = this.accounts.connect(pending.label, email, tokens.scopes, tokens.refreshToken, this.now());
      this.tokens.invalidate(pending.label);
      return account;
    } catch (error) {
      throw this.connectFailure(error);
    }
  }

  /** Revokes the grant at Google (best effort), wipes the local token and reports whether Google confirmed. */
  async revoke(label: GmailAccountLabel): Promise<{ remoteRevoked: boolean } | undefined> {
    const refreshToken = this.accounts.refreshToken(label);
    if (!this.accounts.get(label)) return undefined;
    const remoteRevoked = refreshToken ? await this.oauth.revoke(refreshToken) : false;
    this.accounts.wipeTokens(label, this.now());
    this.tokens.invalidate(label);
    return { remoteRevoked };
  }

  private connectFailure(error: unknown): ConnectError {
    if (error instanceof ConnectError) return error;
    if (error instanceof TokenDecryptionError) return new ConnectError("invalid_state");
    if (error instanceof AccountBindingError) return new ConnectError(error.reason);
    if (error instanceof GoogleAuthError) return new ConnectError(error.reason === "unavailable" ? "unavailable" : "identity_rejected");
    return new ConnectError("unavailable");
  }
}
