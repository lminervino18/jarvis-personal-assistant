import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

export interface DeviceRecord {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = "id, name, created_at, last_seen_at, revoked_at";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toRecord(row: DeviceRow): DeviceRecord {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at };
}

/** Paired devices. Each one has its own bearer token, shown once; only its SHA-256 is stored. */
export class DeviceStore {
  constructor(private readonly db: Db) {}

  create(name: string, now = new Date()): { device: DeviceRecord; token: string } {
    const token = randomBytes(32).toString("base64url");
    const device: DeviceRecord = { id: randomUUID(), name, createdAt: now.toISOString(), lastSeenAt: null, revokedAt: null };
    this.db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.name, hashToken(token), device.createdAt);
    return { device, token };
  }

  list(): DeviceRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM devices ORDER BY created_at DESC`).all() as DeviceRow[];
    return rows.map(toRecord);
  }

  /** Returns the active device that owns the token and records the visit; unknown or revoked tokens give undefined. */
  authenticate(token: string | undefined, now = new Date()): DeviceRecord | undefined {
    if (!token) return undefined;
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL`).get(hashToken(token)) as
      | DeviceRow
      | undefined;
    if (!row) return undefined;
    const lastSeenAt = now.toISOString();
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(lastSeenAt, row.id);
    return toRecord({ ...row, last_seen_at: lastSeenAt });
  }

  isActive(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) !== undefined;
  }

  /** Revokes a device. Returns false when the id is unknown; revoking twice keeps the first date. */
  revoke(id: string, now = new Date()): boolean {
    return this.db.prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now.toISOString(), id).changes > 0;
  }
}
