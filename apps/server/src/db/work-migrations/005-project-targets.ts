export const sql = /* sql */ `
ALTER TABLE tasks ADD COLUMN target_json TEXT;
ALTER TABLE task_publications ADD COLUMN kind TEXT NOT NULL DEFAULT 'jarvis' CHECK (kind IN ('jarvis', 'pr', 'main', 'new'));
ALTER TABLE task_publications ADD COLUMN url TEXT;
`;
