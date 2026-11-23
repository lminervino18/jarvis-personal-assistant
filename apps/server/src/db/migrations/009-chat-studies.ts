export const sql = /* sql */ `
CREATE TABLE wa_studies (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  focus TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'reading', 'ready', 'failed')),
  messages INTEGER NOT NULL DEFAULT 0,
  chunks_done INTEGER NOT NULL DEFAULT 0,
  chunks_total INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT NOT NULL DEFAULT '[]',
  profile TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX wa_studies_batch ON wa_studies(batch_id, created_at);
`;
