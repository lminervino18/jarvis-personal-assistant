import { randomBytes } from "node:crypto";
import type { Db } from "../db/database.js";

export const LINK_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Unguessable public links to one file, so someone without an account can watch or download it in
 * its original quality. Each link stops working after a week.
 */
export class FileLinks {
  constructor(private readonly db: Db) {}

  create(attachmentId: string, now: Date): { token: string; expiresAt: string } {
    const token = randomBytes(18).toString("base64url");
    const expiresAt = new Date(now.getTime() + LINK_DAYS * DAY_MS).toISOString();
    this.db.prepare("INSERT INTO file_links (token, attachment_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(token, attachmentId, now.toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /** The file behind a link that has not expired. */
  resolve(token: string, now: Date): string | undefined {
    const row = this.db.prepare("SELECT attachment_id, expires_at FROM file_links WHERE token = ?").get(token) as { attachment_id: string; expires_at: string } | undefined;
    return row && new Date(row.expires_at) > now ? row.attachment_id : undefined;
  }

  purgeExpired(now: Date): number {
    return this.db.prepare("DELETE FROM file_links WHERE expires_at <= ?").run(now.toISOString()).changes;
  }
}
