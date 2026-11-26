import type { Card } from "@jarvis/contracts";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

const KEY = "pairing";
const CONTEXT = `wa_auth_state:${KEY}`;
const ACCOUNT_KEY = "account";
const ACCOUNT_CONTEXT = `wa_auth_state:${ACCOUNT_KEY}`;

type PairingCardValue = Extract<Card, { kind: "pairing" }>;

interface StoredPairing {
  qr: string;
  expiresAt: string;
}

/** The WhatsApp account the bridge is linked to, as the owner reads it. */
export interface LinkedAccount {
  number: string;
  name?: string;
}

/** What the bridge process tells the server through the database, encrypted at rest: the pairing QR and the linked account. */
export class PairingStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  publish(qr: string, expiresAt: Date, now: Date): void {
    const sealed = this.cipher.encrypt(JSON.stringify({ qr, expiresAt: expiresAt.toISOString() } satisfies StoredPairing), CONTEXT);
    this.db
      .prepare(
        `INSERT INTO wa_auth_state (key, value_ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, updated_at = excluded.updated_at`,
      )
      .run(KEY, sealed, now.toISOString());
  }

  clear(): void {
    this.db.prepare("DELETE FROM wa_auth_state WHERE key = ?").run(KEY);
  }

  publishAccount(account: LinkedAccount, now: Date): void {
    this.put(ACCOUNT_KEY, this.cipher.encrypt(JSON.stringify(account), ACCOUNT_CONTEXT), now);
  }

  account(): LinkedAccount | undefined {
    const row = this.db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = ?").get(ACCOUNT_KEY) as { value_ciphertext: string } | undefined;
    return row ? (JSON.parse(this.cipher.decrypt(row.value_ciphertext, ACCOUNT_CONTEXT)) as LinkedAccount) : undefined;
  }

  forgetAccount(): void {
    this.db.prepare("DELETE FROM wa_auth_state WHERE key = ?").run(ACCOUNT_KEY);
  }

  private put(key: string, value: string, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO wa_auth_state (key, value_ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, updated_at = excluded.updated_at`,
      )
      .run(key, value, now.toISOString());
  }

  card(now: Date): PairingCardValue | undefined {
    const row = this.db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = ?").get(KEY) as { value_ciphertext: string } | undefined;
    if (!row) return undefined;
    const pairing = JSON.parse(this.cipher.decrypt(row.value_ciphertext, CONTEXT)) as StoredPairing;
    return new Date(pairing.expiresAt) > now ? { kind: "pairing", provider: "whatsapp", qr: pairing.qr, expiresAt: pairing.expiresAt } : undefined;
  }
}
