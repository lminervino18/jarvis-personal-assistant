import type { Db } from "../db/database.js";
import { aliasKey, type Expense, type Payment } from "./split.js";

export interface Tricount {
  name: string;
  people: string[];
  expenses: Expense[];
  payments: Payment[];
  createdAt: string;
  updatedAt: string;
}

/** Splits by name, so the owner can add expenses or payments later, and the bank aliases people gave, for every split. */
export class TricountStore {
  constructor(private readonly db: Db) {}

  get(name: string): Tricount | undefined {
    const row = this.db.prepare("SELECT name, data_json, created_at, updated_at FROM tricounts WHERE name_key = ?").get(aliasKey(name)) as
      | { name: string; data_json: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    const data = JSON.parse(row.data_json) as Pick<Tricount, "people" | "expenses" | "payments">;
    return { name: row.name, ...data, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  save(split: Pick<Tricount, "name" | "people" | "expenses" | "payments">, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        "INSERT INTO tricounts (name_key, name, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, data_json = excluded.data_json, updated_at = excluded.updated_at",
      )
      .run(aliasKey(split.name), split.name, JSON.stringify({ people: split.people, expenses: split.expenses, payments: split.payments }), at, at);
  }

  recent(limit = 10): { name: string; updatedAt: string }[] {
    return (this.db.prepare("SELECT name, updated_at FROM tricounts ORDER BY updated_at DESC LIMIT ?").all(limit) as { name: string; updated_at: string }[]).map((row) => ({
      name: row.name,
      updatedAt: row.updated_at,
    }));
  }

  aliases(): Map<string, string> {
    const rows = this.db.prepare("SELECT name_key, alias FROM tricount_aliases").all() as { name_key: string; alias: string }[];
    return new Map(rows.map((row) => [row.name_key, row.alias]));
  }

  setAlias(name: string, alias: string, now: Date): void {
    this.db
      .prepare("INSERT INTO tricount_aliases (name_key, name, alias, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, alias = excluded.alias, updated_at = excluded.updated_at")
      .run(aliasKey(name), name.trim(), alias.trim(), now.toISOString());
  }
}
