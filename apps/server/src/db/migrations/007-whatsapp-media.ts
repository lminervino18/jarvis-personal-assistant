export const sql = /* sql */ `
CREATE TABLE wa_media (
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'sticker')),
  mimetype TEXT,
  file_name TEXT,
  size INTEGER,
  seconds INTEGER,
  voice_note INTEGER NOT NULL DEFAULT 0,
  locator_enc TEXT NOT NULL,
  attachment_id TEXT REFERENCES attachments(id),
  inserted_at TEXT NOT NULL,
  PRIMARY KEY (chat_jid, message_id)
);

CREATE TABLE file_links (
  token TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX file_links_expiry ON file_links (expires_at);
`;
