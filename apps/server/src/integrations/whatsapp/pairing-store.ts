import type { Card } from "@jarvis/contracts";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

const KEY = "pairing";
const CONTEXT = `wa_auth_state:${KEY}`;

type PairingCardValue = Extract<Card, { kind: "pairing" }>;

interface StoredPairing {
  qr: string;
  expiresAt: string;
}

/** Hands the current pairing QR from the bridge process to the server, encrypted at rest. */
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

  card(now: Date): PairingCardValue | undefined {
    const row = this.db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = ?").get(KEY) as { value_ciphertext: string } | undefined;
    if (!row) return undefined;
    const pairing = JSON.parse(this.cipher.decrypt(row.value_ciphertext, CONTEXT)) as StoredPairing;
    return new Date(pairing.expiresAt) > now ? { kind: "pairing", provider: "whatsapp", qr: pairing.qr, expiresAt: pairing.expiresAt } : undefined;
  }
}
