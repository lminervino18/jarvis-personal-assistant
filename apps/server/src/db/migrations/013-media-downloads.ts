export const sql = /* sql */ `
CREATE TABLE transfers_next (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('phone', 'computer', 'link', 'download')),
  link_id TEXT,
  sender TEXT,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  upload_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO transfers_next (id, origin, link_id, sender, name, media_type, size, upload_id, created_at, expires_at, deleted_at)
  SELECT id, origin, link_id, sender, name, media_type, size, upload_id, created_at, expires_at, deleted_at FROM transfers;

DROP TABLE transfers;
ALTER TABLE transfers_next RENAME TO transfers;
CREATE INDEX transfers_live ON transfers (deleted_at, expires_at);

CREATE TABLE media_downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  site TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('max', 'compatible')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  transfer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX media_downloads_status ON media_downloads (status, created_at);
`;
