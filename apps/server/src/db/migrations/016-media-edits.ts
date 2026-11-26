export const sql = /* sql */ `
ALTER TABLE media_jobs ADD COLUMN edit_json TEXT;
ALTER TABLE media_jobs ADD COLUMN stage TEXT;
`;
