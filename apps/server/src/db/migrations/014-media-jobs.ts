export const sql = /* sql */ `
CREATE TABLE media_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('link', 'search', 'transfer')),
  target TEXT NOT NULL,
  site TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('iphone', 'max', 'mp3', 'm4a')),
  send_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  error TEXT,
  transfer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO media_jobs (id, source, target, site, format, status, progress, error, transfer_id, created_at, updated_at)
  SELECT id, 'link', url, site, CASE quality WHEN 'compatible' THEN 'iphone' ELSE 'max' END, status, progress, error, transfer_id, created_at, updated_at
  FROM media_downloads;

DROP TABLE media_downloads;
CREATE INDEX media_jobs_status ON media_jobs (status, created_at);
`;
