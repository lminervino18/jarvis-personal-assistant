export const sql = /* sql */ `
CREATE TABLE service_accounts (
  provider TEXT PRIMARY KEY CHECK (provider IN ('github', 'vercel')),
  account TEXT NOT NULL,
  detail TEXT,
  token_ciphertext TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
