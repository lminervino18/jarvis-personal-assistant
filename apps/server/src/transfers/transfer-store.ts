import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

/** Everything uploaded to transfer, and every link, is gone after a day. */
export const TRANSFER_TTL_MS = 24 * 3_600_000;
/** What one upload link can receive in total, so a leaked link cannot fill the server. */
export const UPLOAD_LINK_MAX_BYTES = 20 * 1024 ** 3;

export type TransferOrigin = "phone" | "computer" | "link" | "download";

export interface Transfer {
  id: string;
  origin: TransferOrigin;
  /** Who sent it through an upload link, as the owner named the link, or the site a download came from. */
  sender?: string;
  linkId?: string;
  name: string;
  mediaType: string;
  size: number;
  uploadId: string;
  createdAt: string;
  expiresAt: string;
}

export interface UploadLink {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
}

interface TransferRow {
  id: string;
  origin: TransferOrigin;
  link_id: string | null;
  sender: string | null;
  name: string;
  media_type: string;
  size: number;
  upload_id: string;
  created_at: string;
  expires_at: string;
}

interface LinkRow {
  id: string;
  label: string | null;
  transfer_id: string | null;
  created_at: string;
  expires_at: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(18).toString("base64url");

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    origin: row.origin,
    ...(row.sender ? { sender: row.sender } : {}),
    ...(row.link_id ? { linkId: row.link_id } : {}),
    name: row.name,
    mediaType: row.media_type,
    size: row.size,
    uploadId: row.upload_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toUploadLink(row: LinkRow): UploadLink {
  return { id: row.id, ...(row.label ? { label: row.label } : {}), createdAt: row.created_at, expiresAt: row.expires_at };
}

/**
 * Files uploaded to pass between devices in their original quality, and the links to upload or
 * share them. Only hashes of link tokens are stored; a token is shown once, when it is created.
 */
export class TransferStore {
  constructor(private readonly db: Db) {}

  add(input: { origin: TransferOrigin; sender?: string; linkId?: string; name: string; mediaType: string; size: number; uploadId: string }, now: Date): Transfer {
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + TRANSFER_TTL_MS).toISOString();
    this.db
      .prepare("INSERT INTO transfers (id, origin, link_id, sender, name, media_type, size, upload_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.origin, input.linkId ?? null, input.sender ?? null, input.name, input.mediaType, input.size, input.uploadId, now.toISOString(), expiresAt);
    return this.get(id, now) as Transfer;
  }

  /** A file still available: not deleted and not expired. */
  get(id: string, now: Date): Transfer | undefined {
    const row = this.db.prepare("SELECT * FROM transfers WHERE id = ? AND deleted_at IS NULL AND expires_at > ?").get(id, now.toISOString()) as TransferRow | undefined;
    return row ? toTransfer(row) : undefined;
  }

  /** Available files, newest first. */
  list(now: Date): Transfer[] {
    const rows = this.db.prepare("SELECT * FROM transfers WHERE deleted_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now.toISOString()) as TransferRow[];
    return rows.map(toTransfer);
  }

  /** Files past their day that still have to leave the disk. */
  expired(now: Date): Transfer[] {
    const rows = this.db.prepare("SELECT * FROM transfers WHERE deleted_at IS NULL AND expires_at <= ?").all(now.toISOString()) as TransferRow[];
    return rows.map(toTransfer);
  }

  markDeleted(id: string, now: Date): boolean {
    return this.db.prepare("UPDATE transfers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now.toISOString(), id).changes > 0;
  }

  /** A link anyone can use to upload files to the owner for a day. Answers the token only now. */
  createUploadLink(label: string | undefined, now: Date): { token: string; link: UploadLink } {
    const token = newToken();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + TRANSFER_TTL_MS).toISOString();
    this.db
      .prepare("INSERT INTO transfer_links (id, kind, token_hash, label, created_at, expires_at) VALUES (?, 'upload', ?, ?, ?, ?)")
      .run(id, hash(token), label ?? null, now.toISOString(), expiresAt);
    return { token, link: { id, ...(label ? { label } : {}), createdAt: now.toISOString(), expiresAt } };
  }

  uploadLink(token: string, now: Date): UploadLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM transfer_links WHERE kind = 'upload' AND token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(hash(token), now.toISOString()) as LinkRow | undefined;
    return row ? toUploadLink(row) : undefined;
  }

  uploadLinks(now: Date): UploadLink[] {
    const rows = this.db
      .prepare("SELECT * FROM transfer_links WHERE kind = 'upload' AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
      .all(now.toISOString()) as LinkRow[];
    return rows.map(toUploadLink);
  }

  revokeLink(id: string, now: Date): boolean {
    return this.db.prepare("UPDATE transfer_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id).changes > 0;
  }

  /** Bytes already received through an upload link. */
  receivedThrough(linkId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM transfers WHERE link_id = ?").get(linkId) as { total: number }).total;
  }

  /** A public link to download one file in its original quality, valid while the file is. */
  createShareLink(transferId: string, now: Date): { token: string; expiresAt: string } | undefined {
    const transfer = this.get(transferId, now);
    if (!transfer) return undefined;
    const token = newToken();
    this.db
      .prepare("INSERT INTO transfer_links (id, kind, token_hash, transfer_id, created_at, expires_at) VALUES (?, 'share', ?, ?, ?, ?)")
      .run(randomUUID(), hash(token), transfer.id, now.toISOString(), transfer.expiresAt);
    return { token, expiresAt: transfer.expiresAt };
  }

  shared(token: string, now: Date): Transfer | undefined {
    const row = this.db
      .prepare("SELECT transfer_id FROM transfer_links WHERE kind = 'share' AND token_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(hash(token), now.toISOString()) as { transfer_id: string } | undefined;
    return row ? this.get(row.transfer_id, now) : undefined;
  }

  /** Forgets links that expired more than a day ago. */
  purgeLinks(now: Date): number {
    return this.db.prepare("DELETE FROM transfer_links WHERE expires_at <= ?").run(new Date(now.getTime() - TRANSFER_TTL_MS).toISOString()).changes;
  }
}
