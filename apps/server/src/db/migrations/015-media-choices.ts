export const sql = /* sql */ `
CREATE TABLE media_choices (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('iphone', 'max', 'mp3', 'm4a')),
  send_json TEXT,
  options_json TEXT NOT NULL,
  chosen INTEGER,
  job_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
