import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { sql as initSql } from "./migrations/001-init.js";

export type Db = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered list of schema migrations. Only append; never edit an applied migration. */
export const migrations: Migration[] = [{ version: 1, name: "init", sql: initSql }];

/**
 * Opens the SQLite database with the settings every process (server, worker, WhatsApp
 * bridge) must share: WAL for concurrent readers, a busy timeout for writers, and
 * enforced foreign keys.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: Db): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }).immediate();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

export function openMigratedDatabase(path: string): Db {
  const db = openDatabase(path);
  migrate(db);
  return db;
}
