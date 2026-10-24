import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/database.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "jarvis_session";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Opaque, server-side owner sessions. Only the SHA-256 of the cookie value is stored. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly ttlDays: number,
  ) {}

  create(userAgent: string | undefined, now = new Date()): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.ttlDays * DAY_MS);
    this.db
      .prepare("INSERT INTO auth_sessions (id_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), now.toISOString(), expiresAt.toISOString(), now.toISOString(), userAgent?.slice(0, 200) ?? null);
    return { token, expiresAt };
  }

  /** Validates a token and slides its expiry at most once per day. */
  validate(token: string | undefined, now = new Date()): boolean {
    if (!token) return false;
    const idHash = hashToken(token);
    const row = this.db.prepare("SELECT expires_at, last_seen_at FROM auth_sessions WHERE id_hash = ?").get(idHash) as
      | { expires_at: string; last_seen_at: string }
      | undefined;
    if (!row) return false;
    if (new Date(row.expires_at) <= now) {
      this.db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(idHash);
      return false;
    }
    if (now.getTime() - new Date(row.last_seen_at).getTime() > DAY_MS) {
      const expiresAt = new Date(now.getTime() + this.ttlDays * DAY_MS).toISOString();
      this.db
        .prepare("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
        .run(now.toISOString(), expiresAt, idHash);
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(hashToken(token));
  }

  revokeAll(): void {
    this.db.prepare("DELETE FROM auth_sessions").run();
  }

  purgeExpired(now = new Date()): number {
    return this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now.toISOString()).changes;
  }
}
