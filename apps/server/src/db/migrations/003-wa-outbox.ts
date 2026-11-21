export const sql = /* sql */ `
CREATE TABLE wa_outbox (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX wa_outbox_pending ON wa_outbox(status, created_at);
`;
