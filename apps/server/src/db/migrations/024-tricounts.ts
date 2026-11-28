export const sql = /* sql */ `
CREATE TABLE tricounts (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tricount_aliases (
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  alias TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
