export const sql = /* sql */ `
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('phone', 'computer', 'link')),
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

CREATE INDEX transfers_live ON transfers (deleted_at, expires_at);

CREATE TABLE transfer_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'share')),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  transfer_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
`;
