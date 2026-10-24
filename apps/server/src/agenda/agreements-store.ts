import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

export type AgreementStatus = "proposed" | "confirmed" | "cancelled";
export type AgreementSource = "conversation" | "whatsapp" | "gmail";

export interface Agreement {
  id: string;
  title: string;
  details: string | null;
  status: AgreementStatus;
  whenUtc: string | null;
  timezone: string | null;
  sourceType: AgreementSource;
  sourceRef: string | null;
  parties: { contactId: string; displayName: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface NewAgreement {
  title: string;
  details?: string;
  partyIds: readonly string[];
  whenUtc?: string;
  timezone: string;
  sourceType: AgreementSource;
  sourceRef?: string;
  turnId?: string;
}

export interface AgreementFilter {
  status?: AgreementStatus;
  contactId?: string;
  fromUtc?: string;
  toUtc?: string;
}

interface AgreementRow {
  id: string;
  title: string;
  details: string | null;
  status: AgreementStatus;
  when_utc: string | null;
  timezone: string | null;
  source_type: AgreementSource;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Agreements with people: proposed → confirmed | cancelled. Every transition is audited
 * and only an explicit confirm moves a proposal to confirmed.
 */
export class AgreementStore {
  constructor(private readonly db: Db) {}

  get(id: string): Agreement | undefined {
    const row = this.db.prepare("SELECT * FROM agreements WHERE id = ?").get(id) as AgreementRow | undefined;
    return row ? this.toAgreement(row) : undefined;
  }

  propose(input: NewAgreement, now = new Date()): Agreement {
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agreements (id, title, details, status, when_utc, timezone, source_type, source_ref, created_turn_id, created_at, updated_at)
           VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.details ?? null,
          input.whenUtc ?? null,
          input.whenUtc ? input.timezone : null,
          input.sourceType,
          input.sourceRef ?? null,
          input.turnId ?? null,
          at,
          at,
        );
      const addParty = this.db.prepare("INSERT OR IGNORE INTO agreement_parties (agreement_id, contact_id) VALUES (?, ?)");
      for (const contactId of input.partyIds) addParty.run(id, contactId);
      this.recordEvent(id, "proposed", null, input.turnId, at);
    })();
    return this.get(id) as Agreement;
  }

  /** Confirms a proposed agreement. Returns undefined when it is not in the proposed state. */
  confirm(id: string, change: { whenUtc?: string; timezone: string; turnId?: string }, now = new Date()): Agreement | undefined {
    const at = now.toISOString();
    const confirmed = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE agreements SET status = 'confirmed', when_utc = COALESCE(?, when_utc), timezone = COALESCE(?, timezone), updated_at = ?
           WHERE id = ? AND status = 'proposed'`,
        )
        .run(change.whenUtc ?? null, change.whenUtc ? change.timezone : null, at, id);
      if (result.changes === 0) return false;
      this.recordEvent(id, "confirmed", change.whenUtc ? `when=${change.whenUtc}` : null, change.turnId, at);
      return true;
    })();
    return confirmed ? this.get(id) : undefined;
  }

  /** Cancels a proposed or confirmed agreement. Returns undefined when it was already cancelled or missing. */
  cancel(id: string, change: { reason?: string; turnId?: string }, now = new Date()): Agreement | undefined {
    const at = now.toISOString();
    const cancelled = this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE agreements SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('proposed', 'confirmed')")
        .run(at, id);
      if (result.changes === 0) return false;
      this.recordEvent(id, "cancelled", change.reason ?? null, change.turnId, at);
      return true;
    })();
    return cancelled ? this.get(id) : undefined;
  }

  list(filter: AgreementFilter, limit: number): { agreements: Agreement[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM agreements a
         WHERE (@status IS NULL OR a.status = @status)
           AND (@contactId IS NULL OR EXISTS (SELECT 1 FROM agreement_parties p WHERE p.agreement_id = a.id AND p.contact_id = @contactId))
           AND (@fromUtc IS NULL OR a.when_utc >= @fromUtc)
           AND (@toUtc IS NULL OR a.when_utc <= @toUtc)
         ORDER BY a.updated_at DESC
         LIMIT @limit`,
      )
      .all({
        status: filter.status ?? null,
        contactId: filter.contactId ?? null,
        fromUtc: filter.fromUtc ?? null,
        toUtc: filter.toUtc ?? null,
        limit: limit + 1,
      }) as AgreementRow[];
    return { agreements: rows.slice(0, limit).map((row) => this.toAgreement(row)), hasMore: rows.length > limit };
  }

  history(id: string): { action: string; detail: string | null; turnId: string | null; at: string }[] {
    return this.db
      .prepare("SELECT action, detail, turn_id AS turnId, at FROM agreement_events WHERE agreement_id = ? ORDER BY at, rowid")
      .all(id) as { action: string; detail: string | null; turnId: string | null; at: string }[];
  }

  private toAgreement(row: AgreementRow): Agreement {
    const parties = this.db
      .prepare(
        `SELECT c.id AS contactId, c.display_name AS displayName FROM agreement_parties p
         JOIN contacts c ON c.id = p.contact_id WHERE p.agreement_id = ? ORDER BY c.display_name`,
      )
      .all(row.id) as Agreement["parties"];
    return {
      id: row.id,
      title: row.title,
      details: row.details,
      status: row.status,
      whenUtc: row.when_utc,
      timezone: row.timezone,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      parties,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private recordEvent(agreementId: string, action: "proposed" | "confirmed" | "cancelled", detail: string | null, turnId: string | undefined, at: string) {
    this.db
      .prepare("INSERT INTO agreement_events (id, agreement_id, action, detail, turn_id, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), agreementId, action, detail, turnId ?? null, at);
  }
}
