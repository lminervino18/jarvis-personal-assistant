import type { GmailAccountLabel } from "@jarvis/contracts";
import type { GoogleAccountStore } from "./account-store.js";
import { GoogleApiError } from "./errors.js";
import { GoogleAuthError, type GoogleOAuthClient } from "./oauth-client.js";

const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Short-lived access tokens, kept in memory only and refreshed from the stored refresh token. */
export class GoogleAccessTokens {
  private readonly cache = new Map<GmailAccountLabel, CachedToken>();

  constructor(
    private readonly accounts: GoogleAccountStore,
    private readonly oauth: GoogleOAuthClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(label: GmailAccountLabel): Promise<string> {
    const cached = this.cache.get(label);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now().getTime()) return cached.token;
    return this.refresh(label);
  }

  invalidate(label: GmailAccountLabel): void {
    this.cache.delete(label);
  }

  private async refresh(label: GmailAccountLabel): Promise<string> {
    const refreshToken = this.requireRefreshToken(label);
    try {
      const tokens = await this.oauth.refresh(refreshToken);
      this.cache.set(label, { token: tokens.accessToken, expiresAt: this.now().getTime() + tokens.expiresInSeconds * 1000 });
      return tokens.accessToken;
    } catch (error) {
      throw this.refreshFailure(label, error);
    }
  }

  private requireRefreshToken(label: GmailAccountLabel): string {
    const account = this.accounts.get(label);
    if (!account) throw new GoogleApiError("not_connected", `La cuenta ${label} no está conectada.`, { account: label });
    if (account.status === "revoked") throw new GoogleApiError("revoked", `El acceso de la cuenta ${label} fue revocado.`, { account: label });
    if (account.status !== "connected") {
      throw new GoogleApiError("auth_expired", `La autorización de la cuenta ${label} venció; hay que reconectarla.`, { account: label });
    }
    const token = this.accounts.refreshToken(label);
    if (!token) throw new GoogleApiError("revoked", `El acceso de la cuenta ${label} fue revocado.`, { account: label });
    return token;
  }

  private refreshFailure(label: GmailAccountLabel, error: unknown): GoogleApiError {
    this.cache.delete(label);
    if (error instanceof GoogleAuthError && error.reason === "invalid_grant") {
      this.accounts.markStatus(label, "expired", "invalid_grant", this.now());
      return new GoogleApiError("auth_expired", `La autorización de la cuenta ${label} venció; hay que reconectarla.`, { account: label });
    }
    if (error instanceof GoogleAuthError && error.reason === "rejected") {
      this.accounts.markStatus(label, "error", "credenciales rechazadas por Google", this.now());
      return new GoogleApiError("upstream_error", "Google rechazó las credenciales de la aplicación.", { account: label });
    }
    return new GoogleApiError("upstream_error", "No se pudo contactar a Google para renovar el acceso.", { retryable: true });
  }
}
