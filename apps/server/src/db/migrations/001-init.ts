export const sql = /* sql */ `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  claude_session_id TEXT,
  session_turns INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  input_mode TEXT NOT NULL CHECK (input_mode IN ('text', 'voice')),
  reply_mode TEXT NOT NULL CHECK (reply_mode IN ('text', 'voice')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
  error_code TEXT,
  claude_session_id TEXT,
  tainted INTEGER NOT NULL DEFAULT 0,
  used_tools INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  stt_ms INTEGER,
  first_text_ms INTEGER,
  first_audio_ms INTEGER,
  client_first_audio_ms INTEGER,
  client_first_text_ms INTEGER
);
CREATE INDEX turns_conversation ON turns(conversation_id, started_at);

CREATE TABLE messages (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  cards_json TEXT NOT NULL DEFAULT '[]',
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, rid);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='rid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rid, new.content);
END;

CREATE TABLE memories (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('preference', 'fact', 'person', 'routine', 'work', 'other')),
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate')),
  source_type TEXT NOT NULL CHECK (source_type IN ('owner_statement', 'extracted', 'import')),
  source_ref TEXT,
  account TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, content='memories', content_rowid='rid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rid, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rid, old.content);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rid, new.content);
END;

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'forgotten')),
  before_content TEXT,
  after_content TEXT,
  turn_id TEXT,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX memory_events_memory ON memory_events(memory_id, at);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE contact_aliases (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner', 'whatsapp', 'gmail', 'import')),
  PRIMARY KEY (contact_id, alias_normalized)
);
CREATE INDEX contact_aliases_lookup ON contact_aliases(alias_normalized);
CREATE TABLE contact_identities (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('whatsapp_jid', 'email', 'phone')),
  value TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);

CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'cancelled')),
  when_utc TEXT,
  timezone TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('conversation', 'whatsapp', 'gmail')),
  source_ref TEXT,
  created_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE agreement_parties (
  agreement_id TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (agreement_id, contact_id)
);
CREATE TABLE agreement_events (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('proposed', 'confirmed', 'cancelled', 'updated')),
  detail TEXT,
  turn_id TEXT,
  at TEXT NOT NULL
);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  timezone TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'internal' CHECK (source IN ('internal')),
  agreement_id TEXT REFERENCES agreements(id) ON DELETE SET NULL,
  created_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX calendar_events_start ON calendar_events(status, start_utc);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  due_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  rrule TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'fired', 'cancelled', 'missed')),
  idempotency_key TEXT UNIQUE,
  created_turn_id TEXT,
  last_fired_utc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reminders_due ON reminders(status, due_utc);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'chat_message')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_utc TEXT NOT NULL,
  locked_until_utc TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX outbox_pending ON outbox(status, next_attempt_utc);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  label TEXT NOT NULL CHECK (label IN ('personal', 'work')),
  email TEXT NOT NULL,
  scopes TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'expired', 'revoked', 'error')),
  last_error TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, label)
);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE wa_chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE wa_messages (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  from_me INTEGER NOT NULL,
  ts_utc TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'media', 'system')),
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('baileys', 'import')),
  import_batch_id TEXT,
  inserted_at TEXT NOT NULL,
  UNIQUE (chat_jid, id)
);
CREATE INDEX wa_messages_chat_ts ON wa_messages(chat_jid, ts_utc);
CREATE VIRTUAL TABLE wa_messages_fts USING fts5(
  text, sender_name, content='wa_messages', content_rowid='rid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER wa_messages_ai AFTER INSERT ON wa_messages BEGIN
  INSERT INTO wa_messages_fts(rowid, text, sender_name) VALUES (new.rid, new.text, new.sender_name);
END;
CREATE TRIGGER wa_messages_ad AFTER DELETE ON wa_messages BEGIN
  INSERT INTO wa_messages_fts(wa_messages_fts, rowid, text, sender_name)
  VALUES ('delete', old.rid, old.text, old.sender_name);
END;
CREATE TRIGGER wa_messages_au AFTER UPDATE OF text, sender_name ON wa_messages BEGIN
  INSERT INTO wa_messages_fts(wa_messages_fts, rowid, text, sender_name)
  VALUES ('delete', old.rid, old.text, old.sender_name);
  INSERT INTO wa_messages_fts(rowid, text, sender_name) VALUES (new.rid, new.text, new.sender_name);
END;
CREATE TABLE wa_sync_state (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('disabled', 'pairing', 'connected', 'disconnected', 'logged_out', 'error', 'imported')),
  earliest_utc TEXT,
  latest_utc TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  detail TEXT
);
CREATE TABLE wa_auth_state (
  key TEXT PRIMARY KEY,
  value_ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tool_executions (
  idempotency_key TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  turn_id TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'rejected', 'expired', 'executed', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  result_json TEXT
);
CREATE INDEX pending_actions_status ON pending_actions(status, expires_at);
`;
