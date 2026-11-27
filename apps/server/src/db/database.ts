import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { sql as initSql } from "./migrations/001-init.js";
import { sql as syncCursorsSql } from "./migrations/002-sync-cursors.js";
import { sql as waOutboxSql } from "./migrations/003-wa-outbox.js";
import { sql as turnUsageSql } from "./migrations/004-turn-usage.js";
import { sql as pagesSql } from "./migrations/005-pages.js";
import { sql as attachmentsSql } from "./migrations/006-attachments.js";
import { sql as whatsappMediaSql } from "./migrations/007-whatsapp-media.js";
import { sql as videosSql } from "./migrations/008-videos.js";
import { sql as chatStudiesSql } from "./migrations/009-chat-studies.js";
import { sql as videoSendSql } from "./migrations/010-video-send.js";
import { sql as serviceAccountsSql } from "./migrations/011-service-accounts.js";
import { sql as transfersSql } from "./migrations/012-transfers.js";
import { sql as mediaDownloadsSql } from "./migrations/013-media-downloads.js";
import { sql as mediaJobsSql } from "./migrations/014-media-jobs.js";
import { sql as mediaChoicesSql } from "./migrations/015-media-choices.js";
import { sql as mediaEditsSql } from "./migrations/016-media-edits.js";
import { sql as whatsappWatchSql } from "./migrations/017-whatsapp-watch.js";
import { sql as whatsappQuotesSql } from "./migrations/018-whatsapp-quotes.js";
import { sql as whatsappPeopleSql } from "./migrations/019-whatsapp-people.js";
import { sql as whatsappWakeSql } from "./migrations/020-whatsapp-wake.js";
import { sql as whatsappSendersSql } from "./migrations/021-whatsapp-senders.js";
import { sql as tasksSql } from "./work-migrations/001-tasks.js";
import { sql as plannerSessionSql } from "./work-migrations/002-planner-session.js";
import { sql as taskArchiveSql } from "./work-migrations/004-task-archive.js";
import { sql as publicationsSql } from "./work-migrations/003-publications.js";
import { sql as projectTargetsSql } from "./work-migrations/005-project-targets.js";

export type Db = Database.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered list of schema migrations. Only append; never edit an applied migration. */
export const migrations: Migration[] = [
  { version: 1, name: "init", sql: initSql },
  { version: 2, name: "sync_cursors", sql: syncCursorsSql },
  { version: 3, name: "wa_outbox", sql: waOutboxSql },
  { version: 4, name: "turn_usage", sql: turnUsageSql },
  { version: 5, name: "pages", sql: pagesSql },
  { version: 6, name: "attachments", sql: attachmentsSql },
  { version: 7, name: "whatsapp_media", sql: whatsappMediaSql },
  { version: 8, name: "videos", sql: videosSql },
  { version: 9, name: "chat_studies", sql: chatStudiesSql },
  { version: 10, name: "video_send", sql: videoSendSql },
  { version: 11, name: "service_accounts", sql: serviceAccountsSql },
  { version: 12, name: "transfers", sql: transfersSql },
  { version: 13, name: "media_downloads", sql: mediaDownloadsSql },
  { version: 14, name: "media_jobs", sql: mediaJobsSql },
  { version: 15, name: "media_choices", sql: mediaChoicesSql },
  { version: 16, name: "media_edits", sql: mediaEditsSql },
  { version: 17, name: "whatsapp_watch", sql: whatsappWatchSql },
  { version: 18, name: "whatsapp_quotes", sql: whatsappQuotesSql },
  { version: 19, name: "whatsapp_people", sql: whatsappPeopleSql },
  { version: 20, name: "whatsapp_wake", sql: whatsappWakeSql },
  { version: 21, name: "whatsapp_senders", sql: whatsappSendersSql },
];

/**
 * Migrations of the work database (delegated tasks). It is a separate file so the agent
 * runner never mounts the personal database.
 */
export const workMigrations: Migration[] = [
  { version: 1, name: "tasks", sql: tasksSql },
  { version: 2, name: "planner_session", sql: plannerSessionSql },
  { version: 3, name: "publications", sql: publicationsSql },
  { version: 4, name: "task_archive", sql: taskArchiveSql },
  { version: 5, name: "project_targets", sql: projectTargetsSql },
];

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

export function migrate(db: Db, list: readonly Migration[] = migrations): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const newlyApplied: number[] = [];
  for (const migration of list) {
    if (isApplied.get(migration.version)) continue;
    const applied = db.transaction(() => {
      if (isApplied.get(migration.version)) return false;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      return true;
    }).immediate();
    if (applied) newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

export function openMigratedDatabase(path: string, list: readonly Migration[] = migrations): Db {
  const db = openDatabase(path);
  migrate(db, list);
  return db;
}
