import type { Db } from "../../db/database.js";

/** The file name of Jarvis's voice notes, which tells them apart from other attachments sent to a chat. */
export const VOICE_NOTE_NAME = "nota-de-voz.ogg";

/** Whether Jarvis already spoke to a chat with its own voice: a voice note or a video sent there before. */
export function jarvisSpokeTo(db: Db, jid: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM wa_outbox o JOIN attachments a ON a.id = o.attachment_id WHERE o.chat_jid = ? AND a.name = ? AND o.status != 'failed' UNION ALL SELECT 1 FROM video_deliveries WHERE channel = 'whatsapp' AND recipient = ? LIMIT 1",
      )
      .get(jid, VOICE_NOTE_NAME, jid) !== undefined
  );
}
