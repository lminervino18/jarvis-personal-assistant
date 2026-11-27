export const sql = /* sql */ `
CREATE INDEX wa_messages_sender_ts ON wa_messages (sender_jid, ts_utc);
`;
