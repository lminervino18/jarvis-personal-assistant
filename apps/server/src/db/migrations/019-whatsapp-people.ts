export const sql = /* sql */ `
CREATE TABLE wa_lid_map (
  lid TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE wa_auto_replies ADD COLUMN person TEXT;
CREATE INDEX wa_auto_replies_person ON wa_auto_replies (person, created_at);
`;
