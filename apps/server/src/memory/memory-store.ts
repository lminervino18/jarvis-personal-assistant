import { randomUUID } from "node:crypto";
import type { MemoryCategory } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import { toFtsQuery } from "../util/fts.js";

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  status: "active" | "candidate";
  sourceType: "owner_statement" | "extracted" | "import";
  sourceRef: string | null;
  account: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  content: string;
  category: MemoryCategory;
  status: "active" | "candidate";
  source_type: Memory["sourceType"];
  source_ref: string | null;
  account: string | null;
  created_at: string;
  updated_at: string;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    status: row.status,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    account: row.account,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeContent(content: string): string {
  return content.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface NewMemory {
  content: string;
  category: MemoryCategory;
  sourceType: Memory["sourceType"];
  sourceRef?: string;
  account?: string;
  status?: Memory["status"];
  turnId?: string;
}

/** Memories with provenance and an audit trail of every change. */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  get(id: string): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }

  search(query: string, options: { category?: MemoryCategory; limit?: number } = {}): Memory[] {
    const limit = options.limit ?? 10;
    const match = toFtsQuery(query);
    const categoryFilter = options.category ? "AND m.category = @category" : "";
    if (!match) {
      return (
        this.db
          .prepare(`SELECT * FROM memories m WHERE 1 = 1 ${categoryFilter} ORDER BY m.updated_at DESC LIMIT @limit`)
          .all({ category: options.category, limit }) as MemoryRow[]
      ).map(toMemory);
    }
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
           WHERE memories_fts MATCH @match ${categoryFilter}
           ORDER BY bm25(memories_fts) LIMIT @limit`,
        )
        .all({ match, category: options.category, limit }) as MemoryRow[]
    ).map(toMemory);
  }

  findDuplicate(content: string): Memory | undefined {
    const target = normalizeContent(content);
    return this.search(content, { limit: 20 }).find((memory) => normalizeContent(memory.content) === target);
  }

  create(input: NewMemory, now = new Date()): Memory {
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, content, category, status, source_type, source_ref, account, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.content,
          input.category,
          input.status ?? "active",
          input.sourceType,
          input.sourceRef ?? null,
          input.account ?? null,
          at,
          at,
        );
      this.recordEvent(id, "created", null, input.content, input.turnId, null, at);
    })();
    return this.get(id) as Memory;
  }

  update(id: string, content: string, turnId?: string, now = new Date()): Memory | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET content = ?, status = 'active', updated_at = ? WHERE id = ?").run(content, at, id);
      this.recordEvent(id, "updated", existing.content, content, turnId, null, at);
    })();
    return this.get(id);
  }

  /**
   * Deletes the memory and scrubs its text from the audit trail, keeping only the fact
   * that something was forgotten and when.
   */
  forget(id: string, reason: string | undefined, turnId?: string, now = new Date()): Memory | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.db.prepare("UPDATE memory_events SET before_content = NULL, after_content = NULL WHERE memory_id = ?").run(id);
      this.recordEvent(id, "forgotten", null, null, turnId, reason ?? null, at);
    })();
    return existing;
  }

  history(id: string): { action: string; at: string; beforeContent: string | null; afterContent: string | null }[] {
    return (
      this.db
        .prepare("SELECT action, at, before_content, after_content FROM memory_events WHERE memory_id = ? ORDER BY at, rowid")
        .all(id) as { action: string; at: string; before_content: string | null; after_content: string | null }[]
    ).map((row) => ({ action: row.action, at: row.at, beforeContent: row.before_content, afterContent: row.after_content }));
  }

  private recordEvent(
    memoryId: string,
    action: "created" | "updated" | "forgotten",
    before: string | null,
    after: string | null,
    turnId: string | undefined,
    reason: string | null,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_events (id, memory_id, action, before_content, after_content, turn_id, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), memoryId, action, before, after, turnId ?? null, reason, at);
  }
}
