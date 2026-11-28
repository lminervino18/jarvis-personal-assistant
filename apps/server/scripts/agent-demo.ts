import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMigratedDatabase, workMigrations } from "../src/db/database.js";
import type { AgentBackend } from "../src/tasks/agent-backend.js";
import { ClaudeAgentBackend } from "../src/tasks/claude-agent-backend.js";
import { checkControlledCriteria, controlledAgents, CONTROLLED_TASK, seedFixtureProjects } from "../src/tasks/controlled-scenario.js";
import { loadRunnerConfig } from "../src/tasks/runner-config.js";
import { ScriptedAgentBackend } from "../src/tasks/scripted-agent-backend.js";
import { defaultRunnerLimits, TaskRunner } from "../src/tasks/task-runner.js";
import { TaskService } from "../src/tasks/task-service.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { WorkLayout } from "../src/tasks/workspace.js";

const useClaude = process.argv.includes("--claude");
const reportPath = process.argv.find((arg) => arg.endsWith(".json"));
const workDir = mkdtempSync(join(tmpdir(), "jarvis-agent-demo-"));
seedFixtureProjects(workDir);

const db = openMigratedDatabase(join(workDir, "work.db"), workMigrations);
const store = new TaskStore(db);
const layout = new WorkLayout(workDir);
const service = new TaskService(store, layout, { defaultBudgetUsd: Number(process.env.DEMO_TASK_BUDGET_USD ?? 3), maxAttachmentBytes: 1024 * 1024 });
const denied: string[] = [];
const backend: AgentBackend = useClaude
  ? new ClaudeAgentBackend({
      ...loadRunnerConfig({ ...process.env, WORK_DIR: workDir }).agent,
      onDenied: (role, tool, reason) => denied.push(`${role}: ${tool} (${reason})`),
    })
  : new ScriptedAgentBackend(controlledAgents());
const log = {
  info: () => {},
  warn: (data: object, message?: string) => console.warn(message, JSON.stringify(data)),
  error: (data: object, message?: string) => console.error(message, JSON.stringify(data)),
};
const runner = new TaskRunner({ store, layout, backend, limits: defaultRunnerLimits, log, timezone: "America/Argentina/Buenos_Aires" });

const created = service.create(CONTROLLED_TASK, new Date());
if (!created.ok) throw new Error(created.message);
const startedAt = Date.now();
await runner.runUntilIdle();
const task = store.require(created.task.id);
const runs = db
  .prepare("SELECT phase, iteration, status, models_json, cost_usd, turns, plan_utilization, error_code, started_at, ended_at FROM task_runs WHERE task_id = ? ORDER BY started_at")
  .all(task.id) as {
  phase: string;
  iteration: number;
  status: string;
  models_json: string;
  cost_usd: number;
  turns: number;
  plan_utilization: number | null;
  error_code: string | null;
  started_at: string;
  ended_at: string;
}[];
const independent = checkControlledCriteria(layout.paths(task.id).work);

const report = {
  backend: backend.name,
  workDir,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  status: task.status,
  blocker: task.blocker ?? null,
  iterations: task.iteration,
  fixRounds: task.fixRounds,
  costUsd: Number(task.costUsd.toFixed(4)),
  runs: runs.map((run) => ({ ...run, models: JSON.parse(run.models_json) as string[], models_json: undefined })),
  spec: task.spec?.acceptanceCriteria ?? [],
  review: task.review ?? null,
  changedFiles: task.evidence?.changedFiles ?? [],
  independentCheck: independent,
  deniedToolCalls: denied,
  events: store.events(task.id, 100).map((event) => `${event.createdAt} ${event.kind}: ${event.message}`),
};

console.log(`Backend: ${report.backend} · estado final: ${report.status} · iteraciones: ${report.iterations} · costo estimado USD ${report.costUsd} · ${report.seconds} s`);
for (const run of report.runs) {
  const plan = run.plan_utilization === null ? "" : ` plan=${Math.round(run.plan_utilization * 100)}%`;
  console.log(`  ${run.phase} #${run.iteration} ${run.status} ${run.models.join(",")} turnos=${run.turns} USD ${run.cost_usd.toFixed(4)}${plan}${run.error_code ? ` error=${run.error_code}` : ""}`);
}
console.log(`Revisor: ${task.review?.verdict ?? "sin revisión"} · ${task.review?.summary ?? ""}`);
console.log("Verificación independiente del resultado (ejecutando código):");
for (const check of independent) console.log(`  ${check.id} ${check.pass ? "PASA" : "FALLA"} · ${check.evidence}`);
if (denied.length) console.log(`Herramientas denegadas: ${denied.length}`);
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
db.close();
process.exit(task.status === "ready" && independent.every((check) => check.pass) ? 0 : 1);
