export const sql = /* sql */ `
CREATE TABLE build_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'assistant', 'system')),
  text TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX build_messages_pending ON build_messages(handled, id);

CREATE TABLE build_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'waiting')),
  activity TEXT,
  todos_json TEXT,
  resume_at TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  base_commit TEXT,
  reset_needed INTEGER NOT NULL DEFAULT 0,
  ship_task_id TEXT,
  reported_task_id TEXT,
  failed_ships INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;
