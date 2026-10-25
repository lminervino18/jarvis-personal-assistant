// SYNTHETIC DATA ONLY: generated for the restore test, contains no real person, message or credential.
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const dataDir = process.env.DATA_DIR ?? "/data";
const db = new Database(`${dataDir}/jarvis.db`);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const now = "2026-01-01T00:00:00.000Z";
const messages = Array.from({ length: 200 }, (_, index) => index);

db.transaction(() => {
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run("conv-synthetic", "Conversacion sintetica", now, now);
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, 'conv-synthetic', ?, ?, ?)",
  );
  for (const index of messages) {
    insertMessage.run(`msg-synthetic-${index}`, index % 2 === 0 ? "user" : "assistant", `mensaje sintetico numero ${index} sobre cafe y bicicletas`, now);
  }
  db.prepare(
    "INSERT INTO memories (id, content, category, status, source_type, created_at, updated_at) VALUES (?, ?, 'preference', 'active', 'owner_statement', ?, ?)",
  ).run("mem-synthetic-1", "Prefiere el cafe sin azucar (dato sintetico)", now, now);
  db.prepare(
    "INSERT INTO reminders (id, text, due_utc, timezone, status, created_at, updated_at) VALUES (?, ?, ?, 'America/Argentina/Buenos_Aires', 'scheduled', ?, ?)",
  ).run("rem-synthetic-1", "Recordatorio sintetico", "2099-01-01T00:00:00.000Z", now, now);
})();
db.close();

mkdirSync(`${dataDir}/memory`, { recursive: true });
writeFileSync(`${dataDir}/memory/loren.md`, "# Perfil sintetico\n\nContenido ficticio para la prueba de restauracion.\n");
console.log("seeded");
