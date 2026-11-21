export const sql = /* sql */ `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  ref INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  project TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  external_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_owner', 'ready', 'accepted', 'failed', 'cancelled')),
  phase TEXT CHECK (phase IN ('plan', 'execute', 'review')),
  paused INTEGER NOT NULL DEFAULT 0,
  iteration INTEGER NOT NULL DEFAULT 0,
  fix_rounds INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  spec_json TEXT,
  report_json TEXT,
  review_json TEXT,
  evidence_json TEXT,
  blocker_json TEXT,
  pending_feedback_json TEXT NOT NULL DEFAULT '[]',
  executor_session_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  budget_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (source, external_ref)
);
CREATE INDEX tasks_claimable ON tasks(status, paused, not_before);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'execute', 'review')),
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  lease_until TEXT,
  session_id TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  plan_utilization REAL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX task_runs_task ON task_runs(task_id, started_at);
CREATE UNIQUE INDEX task_runs_one_active ON task_runs(task_id) WHERE status = 'running';

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 0,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id, id);
CREATE INDEX task_events_notify ON task_events(notify, id);

CREATE TABLE task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX task_approvals_task ON task_approvals(task_id, status);

CREATE TABLE runner_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at TEXT NOT NULL,
  info_json TEXT NOT NULL,
  hold_until TEXT
);

CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
