import { createHash, randomBytes } from "node:crypto";
import type { GmailAccountLabel } from "@jarvis/contracts";
import type { TokenCipher } from "../crypto/token-cipher.js";
import type { Db } from "../db/database.js";
import { createPkcePair } from "./google/oauth-client.js";

const STATE_TTL_MS = 10 * 60 * 1000;

export interface StartedAuthorization {
  state: string;
  challenge: string;
}

export interface ConsumedAuthorization<Label extends string> {
  label: Label;
  verifier: string;
}

const hashState = (state: string) => createHash("sha256").update(state).digest("hex");
const verifierContext = (provider: string, stateHash: string) => `oauth_states:${provider}:${stateHash}`;

/**
 * Single-use OAuth `state` records. Only the SHA-256 of the state is stored, and the PKCE
 * verifier is encrypted, so a database read alone cannot complete someone else's flow.
 */
export class OAuthStateStore<Label extends string = GmailAccountLabel> {
  constructor(
    private readonly db: Db,
    private readonly cipher: TokenCipher,
    private readonly provider = "google",
  ) {}

  start(label: Label, now: Date): StartedAuthorization {
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now.toISOString());
    const state = randomBytes(32).toString("base64url");
    const { verifier, challenge } = createPkcePair();
    const stateHash = hashState(state);
    this.db
      .prepare(
        "INSERT INTO oauth_states (state_hash, provider, label, verifier_ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        stateHash,
        this.provider,
        label,
        this.cipher.encrypt(verifier, verifierContext(this.provider, stateHash)),
        now.toISOString(),
        new Date(now.getTime() + STATE_TTL_MS).toISOString(),
      );
    return { state, challenge };
  }

  /** Returns the pending authorization and deletes it; unknown, reused or expired states yield undefined. */
  consume(state: string, now: Date): ConsumedAuthorization<Label> | undefined {
    const stateHash = hashState(state);
    const row = this.db
      .prepare("DELETE FROM oauth_states WHERE state_hash = ? AND provider = ? RETURNING label, verifier_ciphertext, expires_at")
      .get(stateHash, this.provider) as { label: Label; verifier_ciphertext: string; expires_at: string } | undefined;
    if (!row || new Date(row.expires_at) <= now) return undefined;
    return { label: row.label, verifier: this.cipher.decrypt(row.verifier_ciphertext, verifierContext(this.provider, stateHash)) };
  }
}
