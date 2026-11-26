export const sql = /* sql */ `
CREATE TABLE wa_watch_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_rid INTEGER NOT NULL
);

CREATE TABLE wa_auto_replies (
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_jid, message_id)
);

CREATE INDEX wa_auto_replies_recent ON wa_auto_replies (chat_jid, created_at);
`;
