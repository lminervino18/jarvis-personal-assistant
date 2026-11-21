export const sql = /* sql */ `
CREATE TABLE sync_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
