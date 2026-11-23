// Voice turn latency and outcome report from jarvis.db. Run inside the server container:
//   docker compose exec -T -e SINCE=2026-11-23T00:00:00Z server node - < infra/scripts/voice-report.cjs
const Database = require("better-sqlite3");

const db = new Database("/data/jarvis.db", { readonly: true });
const since = process.env.SINCE ?? "1970-01-01T00:00:00Z";
const rows = db
  .prepare("SELECT input_mode, status, used_tools, stt_ms, first_text_ms, first_audio_ms, client_first_audio_ms FROM turns WHERE started_at >= ? ORDER BY started_at")
  .all(since);

function percentile(values, p) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : "-";
}

function column(turns, key) {
  const values = turns.map((turn) => turn[key]);
  return `${percentile(values, 0.5)} / ${percentile(values, 0.95)} ms (n=${values.filter((value) => value !== null).length})`;
}

const voice = rows.filter((turn) => turn.input_mode === "voice");
const outcomes = {};
for (const turn of voice) outcomes[turn.status] = (outcomes[turn.status] ?? 0) + 1;
console.log(`since ${since}: ${voice.length} voice turns`, JSON.stringify(outcomes));
for (const [label, turns] of [["voice, completed", voice.filter((turn) => turn.status === "completed")], ["voice, completed, no tools", voice.filter((turn) => turn.status === "completed" && !turn.used_tools)]]) {
  console.log(`${label} (n=${turns.length})`);
  console.log(`  stt            p50 / p95: ${column(turns, "stt_ms")}`);
  console.log(`  first text     p50 / p95: ${column(turns, "first_text_ms")}`);
  console.log(`  first audio    p50 / p95: ${column(turns, "first_audio_ms")} (server)`);
  console.log(`  heard by phone p50 / p95: ${column(turns, "client_first_audio_ms")}`);
}
