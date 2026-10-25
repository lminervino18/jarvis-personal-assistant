import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openMigratedDatabase } from "../src/db/database.js";
import { importExport } from "../src/integrations/whatsapp/importer.js";

const USAGE = `Usage: wa-import <export.txt> --chat "<chat name>" [--me "<your name in the export>"] [--group] [--date-order dmy|mdy]

Imports a WhatsApp "Export chat" (.txt, without media) into the local database. Re-importing is safe.
Uses DATA_DIR (default ./data) and TIMEZONE (default America/Argentina/Buenos_Aires).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chat: { type: "string" },
    me: { type: "string" },
    group: { type: "boolean", default: false },
    "date-order": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const file = positionals[0];
const dateOrder = values["date-order"];
if (values.help || !file || !values.chat || (dateOrder !== undefined && dateOrder !== "dmy" && dateOrder !== "mdy")) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}

const dbPath = resolve(process.env.DATA_DIR ?? "./data", "jarvis.db");
const db = openMigratedDatabase(dbPath);
const summary = importExport(db, {
  text: readFileSync(resolve(file), "utf8"),
  chatName: values.chat,
  timezone: process.env.TIMEZONE ?? "America/Argentina/Buenos_Aires",
  me: values.me,
  isGroup: values.group || undefined,
  dateOrder,
});
db.close();

console.log(`Chat: ${values.chat} (${summary.chatJid}, ${summary.isGroup ? "group" : "direct"})`);
console.log(`Parsed ${summary.parsed} messages (date order ${summary.dateOrder}); ${summary.inserted} new, ${summary.duplicates} already present.`);
console.log(`Coverage: ${summary.earliest ?? "-"} to ${summary.latest ?? "-"}`);
if (summary.unparsedLines > 0) console.warn(`Skipped ${summary.unparsedLines} lines that were not part of any message or had an impossible date.`);
