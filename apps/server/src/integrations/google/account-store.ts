import { randomUUID } from "node:crypto";
import type { GmailAccountLabel } from "@jarvis/contracts";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

export type GoogleAccountStatus = "connected" | "expired" | "revoked" | "error";

export interface GoogleAccount {
  id: string;
  label: GmailAccountLabel;
  email: string;
  scopes: string[];
  status: GoogleAccountStatus;
  lastError: string | null;
  connectedAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  label: GmailAccountLabel;
  email: string;
  scopes: string;
  status: GoogleAccountStatus;
  last_error: string | null;
  connected_at: string;
  updated_at: string;
}

export class AccountBindingError extends Error {
  constructor(readonly reason: "label_bound" | "email_bound") {
    super(`google account binding refused: ${reason}`);
  }
}

const tokenContext = (label: GmailAccountLabel) => `oauth_accounts:google:${label}`;

function toAccount(row: AccountRow): GoogleAccount {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    scopes: row.scopes.split(" ").filter(Boolean),
    status: row.status,
    lastError: row.last_error,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

/** Persistence for Google accounts. Each label is bound to the real email Google reported. */
export class GoogleAccountStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  list(): GoogleAccount[] {
    const rows = this.db.prepare("SELECT * FROM oauth_accounts WHERE provider = 'google' ORDER BY label").all() as AccountRow[];
    return rows.map(toAccount);
  }

  get(label: GmailAccountLabel): GoogleAccount | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_accounts WHERE provider = 'google' AND label = ?").get(label) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : undefined;
  }

  /**
   * Stores a refresh token under a label. Refuses a label bound to a different email
   * (unless the owner revoked it) and an email already stored under the other label.
   */
  connect(label: GmailAccountLabel, email: string, scopes: string[], refreshToken: string, now: Date): GoogleAccount {
    const store = this.db.transaction(() => {
      const existing = this.get(label);
      if (existing && existing.email !== email && existing.status !== "revoked") throw new AccountBindingError("label_bound");
      const sameEmail = this.list().find((account) => account.email === email && account.label !== label);
      if (sameEmail && sameEmail.status !== "revoked") throw new AccountBindingError("email_bound");
      const stamp = now.toISOString();
      this.db
        .prepare(
          `INSERT INTO oauth_accounts (id, provider, label, email, scopes, token_ciphertext, status, last_error, connected_at, updated_at)
           VALUES (?, 'google', ?, ?, ?, ?, 'connected', NULL, ?, ?)
           ON CONFLICT (provider, label) DO UPDATE SET email = excluded.email, scopes = excluded.scopes,
             token_ciphertext = excluded.token_ciphertext, status = 'connected', last_error = NULL,
             connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        )
        .run(randomUUID(), label, email, scopes.join(" "), this.cipher.encrypt(refreshToken, tokenContext(label)), stamp, stamp);
    });
    store.immediate();
    return this.get(label) as GoogleAccount;
  }

  refreshToken(label: GmailAccountLabel): string | undefined {
    const row = this.db
      .prepare("SELECT token_ciphertext FROM oauth_accounts WHERE provider = 'google' AND label = ? AND status != 'revoked'")
      .get(label) as { token_ciphertext: string } | undefined;
    return row?.token_ciphertext ? this.cipher.decrypt(row.token_ciphertext, tokenContext(label)) : undefined;
  }

  markStatus(label: GmailAccountLabel, status: Exclude<GoogleAccountStatus, "connected">, lastError: string | null, now: Date): void {
    this.db
      .prepare("UPDATE oauth_accounts SET status = ?, last_error = ?, updated_at = ? WHERE provider = 'google' AND label = ?")
      .run(status, lastError, now.toISOString(), label);
  }

  /** Re-encrypts tokens still sealed with the previous key. Returns how many rows were rewrapped. */
  rewrapTokens(): number {
    const rows = this.db.prepare("SELECT label, token_ciphertext FROM oauth_accounts WHERE provider = 'google' AND token_ciphertext != ''").all() as {
      label: GmailAccountLabel;
      token_ciphertext: string;
    }[];
    const stale = rows.filter((row) => !this.cipher.isCurrent(row.token_ciphertext));
    for (const row of stale) {
      const token = this.cipher.decrypt(row.token_ciphertext, tokenContext(row.label));
      this.db
        .prepare("UPDATE oauth_accounts SET token_ciphertext = ? WHERE provider = 'google' AND label = ?")
        .run(this.cipher.encrypt(token, tokenContext(row.label)), row.label);
    }
    return stale.length;
  }

  /** Marks the account revoked and wipes the stored token; the email stays visible in status. */
  wipeTokens(label: GmailAccountLabel, now: Date): void {
    this.db
      .prepare(
        "UPDATE oauth_accounts SET status = 'revoked', token_ciphertext = '', last_error = NULL, updated_at = ? WHERE provider = 'google' AND label = ?",
      )
      .run(now.toISOString(), label);
  }
}
