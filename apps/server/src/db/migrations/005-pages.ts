export const sql = /* sql */ `
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  html TEXT,
  error TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE page_responses (
  id INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX page_responses_page ON page_responses(page_id, id);
`;
