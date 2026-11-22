export const sql = /* sql */ `
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE wa_outbox ADD COLUMN attachment_id TEXT REFERENCES attachments(id);

CREATE TABLE page_assets (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  PRIMARY KEY (page_id, attachment_id)
);
`;
