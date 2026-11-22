export const sql = /* sql */ `
CREATE TABLE task_publications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'published', 'failed')),
  commit_title TEXT NOT NULL,
  step TEXT,
  commit_sha TEXT,
  message TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_publications_task ON task_publications(task_id, requested_at);
CREATE INDEX task_publications_active ON task_publications(status) WHERE status IN ('queued', 'running');
CREATE INDEX tasks_project ON tasks(project, updated_at);
`;
