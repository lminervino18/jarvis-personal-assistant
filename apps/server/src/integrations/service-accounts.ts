import type { TokenCipher } from "../crypto/token-cipher.js";
import type { Db } from "../db/database.js";

export type ServiceProvider = "github" | "vercel";

export interface ServiceAccount {
  provider: ServiceProvider;
  /** The login the service reported for the token. */
  account: string;
  /** Provider data that is not secret, such as the Vercel team that owns the projects domain. */
  detail: string | null;
  connectedAt: string;
}

interface Row {
  provider: ServiceProvider;
  account: string;
  detail: string | null;
  token_ciphertext: string;
  connected_at: string;
}

const context = (provider: ServiceProvider) => `service_accounts:${provider}`;

/** The owner's GitHub and Vercel accounts, one per service, with the token encrypted at rest. */
export class ServiceAccountStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  get(provider: ServiceProvider): ServiceAccount | undefined {
    const row = this.db.prepare("SELECT * FROM service_accounts WHERE provider = ?").get(provider) as Row | undefined;
    return row ? { provider: row.provider, account: row.account, detail: row.detail, connectedAt: row.connected_at } : undefined;
  }

  token(provider: ServiceProvider): string | undefined {
    const row = this.db.prepare("SELECT token_ciphertext FROM service_accounts WHERE provider = ?").get(provider) as Pick<Row, "token_ciphertext"> | undefined;
    return row ? this.cipher.decrypt(row.token_ciphertext, context(provider)) : undefined;
  }

  connect(input: { provider: ServiceProvider; account: string; detail?: string; token: string }, now: Date): ServiceAccount {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO service_accounts (provider, account, detail, token_ciphertext, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET account = excluded.account, detail = excluded.detail, token_ciphertext = excluded.token_ciphertext,
           connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
      )
      .run(input.provider, input.account, input.detail ?? null, this.cipher.encrypt(input.token, context(input.provider)), stamp, stamp);
    return this.get(input.provider) as ServiceAccount;
  }

  disconnect(provider: ServiceProvider): boolean {
    return this.db.prepare("DELETE FROM service_accounts WHERE provider = ?").run(provider).changes > 0;
  }
}
