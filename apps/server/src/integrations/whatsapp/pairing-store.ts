import type { Card } from "@jarvis/contracts";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

const KEY = "pairing";
const CONTEXT = `wa_auth_state:${KEY}`;
const ACCOUNT_KEY = "account";
const ACCOUNT_CONTEXT = `wa_auth_state:${ACCOUNT_KEY}`;
const PHONE_KEY = "pairing_phone";
const PHONE_CONTEXT = `wa_auth_state:${PHONE_KEY}`;

type PairingCardValue = Extract<Card, { kind: "pairing" }>;

interface StoredPairing {
  qr?: string;
  code?: string;
  expiresAt: string;
}

/** The WhatsApp account the bridge is linked to, as the owner reads it. */
export interface LinkedAccount {
  number: string;
  name?: string;
}

/**
 * What the bridge process and the server tell each other through the database, encrypted at rest:
 * the pairing QR or code, the linked account, and the number to link by code.
 */
export class PairingStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  publish(qr: string, expiresAt: Date, now: Date): void {
    this.store({ qr, expiresAt: expiresAt.toISOString() }, now);
  }

  /** The 8-character code the owner types in WhatsApp, under «Vincular con número de teléfono». */
  publishCode(code: string, expiresAt: Date, now: Date): void {
    this.store({ code, expiresAt: expiresAt.toISOString() }, now);
  }

  /** The owner asked to link by code instead of a QR, for this number (digits with country code). */
  requestCode(phone: string, now: Date): void {
    this.put(PHONE_KEY, this.cipher.encrypt(phone, PHONE_CONTEXT), now);
  }

  /** The number to link by code, once: the request is consumed when the bridge reads it. */
  takeCodeRequest(): string | undefined {
    const row = this.db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = ?").get(PHONE_KEY) as { value_ciphertext: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM wa_auth_state WHERE key = ?").run(PHONE_KEY);
    return this.cipher.decrypt(row.value_ciphertext, PHONE_CONTEXT);
  }

  private store(pairing: StoredPairing, now: Date): void {
    const sealed = this.cipher.encrypt(JSON.stringify(pairing), CONTEXT);
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
    if (new Date(pairing.expiresAt) <= now) return undefined;
    return { kind: "pairing", provider: "whatsapp", ...(pairing.qr ? { qr: pairing.qr } : {}), ...(pairing.code ? { code: pairing.code } : {}), expiresAt: pairing.expiresAt };
  }
}
