export const sql = /* sql */ `
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  page_slug TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE video_versions (
  video_id TEXT NOT NULL REFERENCES videos(id),
  version INTEGER NOT NULL,
  brief_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'voice', 'render', 'verify', 'ready', 'failed', 'cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  timeline_json TEXT,
  duration_ms INTEGER,
  files_json TEXT NOT NULL DEFAULT '{}',
  qa_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (video_id, version)
);

CREATE INDEX video_versions_status ON video_versions(status, updated_at);

CREATE TABLE video_deliveries (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id),
  version INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  recipient TEXT NOT NULL,
  file TEXT NOT NULL CHECK (file IN ('full', 'light', 'link')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  provider_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`;
