export const sql = /* sql */ `
CREATE TABLE drive_uploads (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL CHECK (account IN ('personal', 'work')),
  transfer_id TEXT,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  folder_id TEXT,
  folder_path TEXT,
  session_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  error TEXT,
  drive_file_id TEXT,
  link TEXT,
  duplicate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX drive_uploads_status ON drive_uploads (status, created_at);
`;
