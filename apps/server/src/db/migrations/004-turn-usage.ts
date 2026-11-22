export const sql = /* sql */ `
ALTER TABLE turns ADD COLUMN input_tokens INTEGER;
ALTER TABLE turns ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE turns ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE turns ADD COLUMN output_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN summary_through_rid INTEGER NOT NULL DEFAULT 0;
`;
