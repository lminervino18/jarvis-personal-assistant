import { randomUUID } from "node:crypto";
import type { TaskBlocker, TaskPhase, TaskStatus } from "@jarvis/contracts";
import type { Db } from "../db/database.js";
import type { ExecutionReport, ReviewResult, TaskEvidence, TaskSpec } from "./schemas.js";

interface TaskRow {
  id: string;
  ref: number;
  title: string;
  request: string;
  project: string | null;
  source: string;
  external_ref: string | null;
  status: TaskStatus;
  phase: TaskPhase | null;
  paused: number;
  iteration: number;
  fix_rounds: number;
  attempts: number;
  not_before: string | null;
  spec_json: string | null;
  report_json: string | null;
  review_json: string | null;
  evidence_json: string | null;
  blocker_json: string | null;
  pending_feedback_json: string;
  executor_session_id: string | null;
  cost_usd: number;
  budget_usd: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Task {
  id: string;
  ref: number;
  title: string;
  request: string;
  project?: string;
  source: string;
  externalRef?: string;
  status: TaskStatus;
  phase: TaskPhase | null;
  paused: boolean;
  iteration: number;
  fixRounds: number;
  attempts: number;
  notBefore?: string;
  spec?: TaskSpec;
  report?: ExecutionReport;
  review?: ReviewResult;
  evidence?: TaskEvidence;
  blocker?: TaskBlocker;
  pendingFeedback: string[];
  executorSessionId?: string;
  costUsd: number;
  budgetUsd: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  phase: TaskPhase;
  iteration: number;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  kind: string;
  message: string;
  notify: boolean;
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId?: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface NewTask {
  title: string;
  request: string;
  project?: string;
  source?: string;
  externalRef?: string;
  budgetUsd: number;
  attachmentIds?: string[];
}

export interface RunOutcome {
  status: "succeeded" | "failed" | "interrupted";
  sessionId?: string;
  models: string[];
  costUsd: number;
  turns: number;
  planUtilization?: number;
  errorCode?: string;
  errorMessage?: string;
}

/** Columns a caller may change on a task, with their in-memory shape. */
export interface TaskPatch {
  status?: TaskStatus;
  phase?: TaskPhase | null;
  paused?: boolean;
  iteration?: number;
  fixRounds?: number;
  attempts?: number;
  notBefore?: string | null;
  spec?: TaskSpec;
  report?: ExecutionReport;
  review?: ReviewResult | null;
  evidence?: TaskEvidence;
  blocker?: TaskBlocker | null;
  pendingFeedback?: string[];
  executorSessionId?: string | null;
  budgetUsd?: number;
  finishedAt?: string | null;
}

const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
const parse = <T>(value: string | null): T | undefined => (value === null ? undefined : (JSON.parse(value) as T));

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    request: row.request,
    project: row.project ?? undefined,
    source: row.source,
    externalRef: row.external_ref ?? undefined,
    status: row.status,
    phase: row.phase,
    paused: row.paused === 1,
    iteration: row.iteration,
    fixRounds: row.fix_rounds,
    attempts: row.attempts,
    notBefore: row.not_before ?? undefined,
    spec: parse(row.spec_json),
    report: parse(row.report_json),
    review: parse(row.review_json),
    evidence: parse(row.evidence_json),
    blocker: parse(row.blocker_json),
    pendingFeedback: JSON.parse(row.pending_feedback_json) as string[],
    executorSessionId: row.executor_session_id ?? undefined,
    costUsd: row.cost_usd,
    budgetUsd: row.budget_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function toColumns(patch: TaskPatch): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  const set = (column: string, value: unknown) => {
    if (value !== undefined) columns[column] = value;
  };
  set("status", patch.status);
  set("phase", patch.phase);
  set("paused", patch.paused === undefined ? undefined : patch.paused ? 1 : 0);
  set("iteration", patch.iteration);
  set("fix_rounds", patch.fixRounds);
  set("attempts", patch.attempts);
  set("not_before", patch.notBefore);
  set("spec_json", patch.spec === undefined ? undefined : json(patch.spec));
  set("report_json", patch.report === undefined ? undefined : json(patch.report));
  set("review_json", patch.review === undefined ? undefined : json(patch.review));
  set("evidence_json", patch.evidence === undefined ? undefined : json(patch.evidence));
  set("blocker_json", patch.blocker === undefined ? undefined : json(patch.blocker));
  set("pending_feedback_json", patch.pendingFeedback === undefined ? undefined : JSON.stringify(patch.pendingFeedback));
  set("executor_session_id", patch.executorSessionId);
  set("budget_usd", patch.budgetUsd);
  set("finished_at", patch.finishedAt);
  return columns;
}

/**
 * Persistence for delegated tasks in the work database. State lives here, never in an
 * agent session, so any run can be resumed or redone after a crash.
 */
export class TaskStore {
  constructor(private readonly db: Db) {}

  /** Creates a task, or returns the existing one when the same source reference was already ingested. */
  create(input: NewTask, now: Date): Task {
    return this.db
      .transaction(() => {
        const source = input.source ?? "manual";
        if (input.externalRef) {
          const existing = this.db.prepare("SELECT * FROM tasks WHERE source = ? AND external_ref = ?").get(source, input.externalRef) as
            | TaskRow
            | undefined;
          if (existing) return toTask(existing);
        }
        const id = randomUUID();
        const at = now.toISOString();
        const ref = (this.db.prepare("SELECT COALESCE(MAX(ref), 0) + 1 AS next FROM tasks").get() as { next: number }).next;
        this.db
          .prepare(
            `INSERT INTO tasks (id, ref, title, request, project, source, external_ref, status, phase, budget_usd, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'plan', ?, ?, ?)`,
          )
          .run(id, ref, input.title, input.request, input.project ?? null, source, input.externalRef ?? null, input.budgetUsd, at, at);
        for (const attachmentId of input.attachmentIds ?? []) {
          this.db.prepare("UPDATE task_attachments SET task_id = ? WHERE id = ? AND task_id IS NULL").run(id, attachmentId);
        }
        this.addEvent(id, "created", "Tarea creada", false, now);
        return this.require(id);
      })
      .immediate();
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  getByRef(ref: number): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE ref = ?").get(ref) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  require(id: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  list(filter: "active" | "finished" | "all", limit: number): Task[] {
    const where =
      filter === "active"
        ? "WHERE status IN ('queued', 'running', 'awaiting_owner', 'ready')"
        : filter === "finished"
          ? "WHERE status IN ('accepted', 'failed', 'cancelled')"
          : "";
    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`).all(limit) as TaskRow[];
    return rows.map(toTask);
  }

  /**
   * Applies a patch. With `expect`, the update only happens while the task is still in
   * one of those statuses, so concurrent owner and runner decisions never overwrite each other.
   */
  update(id: string, patch: TaskPatch, now: Date, expect?: readonly TaskStatus[]): boolean {
    const columns = { ...toColumns(patch), updated_at: now.toISOString() };
    const assignments = Object.keys(columns).map((column) => `${column} = @${column}`);
    const guard = expect ? ` AND status IN (${expect.map((status) => `'${status}'`).join(", ")})` : "";
    const result = this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = @id${guard}`).run({ ...columns, id });
    return result.changes > 0;
  }

  addCost(id: string, costUsd: number): void {
    this.db.prepare("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?").run(costUsd, id);
  }

  addEvent(taskId: string, kind: string, message: string, notify: boolean, now: Date, data?: unknown): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, kind, message, notify, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(taskId, kind, message, notify ? 1 : 0, json(data), now.toISOString());
  }

  events(taskId: string, limit = 20): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT id, task_id, kind, message, notify, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, limit) as { id: number; task_id: string; kind: string; message: string; notify: number; created_at: string }[];
    return rows.reverse().map((row) => ({
      id: row.id,
      taskId: row.task_id,
      kind: row.kind,
      message: row.message,
      notify: row.notify === 1,
      createdAt: row.created_at,
    }));
  }

  /** Events the owner should be told about, after a cursor. */
  notifiableEvents(afterId: number, limit = 50): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT id, task_id, kind, message, notify, created_at FROM task_events WHERE notify = 1 AND id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit) as { id: number; task_id: string; kind: string; message: string; notify: number; created_at: string }[];
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, message: row.message, notify: true, createdAt: row.created_at }));
  }

  /**
   * Atomically moves the oldest claimable task to `running` and opens a leased run for it.
   * The partial unique index on task_runs makes a second active run for the same task impossible.
   */
  claimNext(now: Date, leaseMs: number): { task: Task; run: TaskRun } | undefined {
    return this.db
      .transaction(() => {
        const at = now.toISOString();
        const row = this.db
          .prepare(
            `SELECT * FROM tasks WHERE status = 'queued' AND paused = 0 AND phase IS NOT NULL
             AND (not_before IS NULL OR not_before <= ?) ORDER BY updated_at LIMIT 1`,
          )
          .get(at) as TaskRow | undefined;
        if (!row || !row.phase) return undefined;
        this.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'").run(at, row.id);
        const run: TaskRun = { id: randomUUID(), taskId: row.id, phase: row.phase, iteration: row.iteration };
        this.db
          .prepare(
            `INSERT INTO task_runs (id, task_id, phase, iteration, status, lease_until, started_at)
             VALUES (?, ?, ?, ?, 'running', ?, ?)`,
          )
          .run(run.id, run.taskId, run.phase, run.iteration, new Date(now.getTime() + leaseMs).toISOString(), at);
        return { task: this.require(row.id), run };
      })
      .immediate();
  }

  /** Extends a run's lease. Returns false when the run is no longer active. */
  renewLease(runId: string, now: Date, leaseMs: number): boolean {
    const result = this.db
      .prepare("UPDATE task_runs SET lease_until = ? WHERE id = ? AND status = 'running'")
      .run(new Date(now.getTime() + leaseMs).toISOString(), runId);
    return result.changes > 0;
  }

  /** Closes a run once and adds its cost to the task. Closing an already closed run changes nothing. */
  finishRun(run: TaskRun, outcome: RunOutcome, now: Date): void {
    this.db
      .transaction(() => {
        const closed = this.db
          .prepare(
            `UPDATE task_runs SET status = ?, session_id = ?, models_json = ?, cost_usd = ?, turns = ?, plan_utilization = ?,
             error_code = ?, error_message = ?, ended_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'`,
          )
          .run(
            outcome.status,
            outcome.sessionId ?? null,
            JSON.stringify(outcome.models),
            outcome.costUsd,
            outcome.turns,
            outcome.planUtilization ?? null,
            outcome.errorCode ?? null,
            outcome.errorMessage?.slice(0, 500) ?? null,
            now.toISOString(),
            run.id,
          );
        if (closed.changes > 0) this.addCost(run.taskId, outcome.costUsd);
      })
      .immediate();
  }

  /** Runs whose lease expired: their process died. Marks them interrupted and returns their tasks. */
  expireRuns(now: Date): TaskRun[] {
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare("SELECT id, task_id, phase, iteration FROM task_runs WHERE status = 'running' AND lease_until <= ?")
          .all(now.toISOString()) as { id: string; task_id: string; phase: TaskPhase; iteration: number }[];
        for (const row of rows) {
          this.db
            .prepare("UPDATE task_runs SET status = 'interrupted', error_code = 'lease_expired', ended_at = ?, lease_until = NULL WHERE id = ?")
            .run(now.toISOString(), row.id);
        }
        return rows.map((row) => ({ id: row.id, taskId: row.task_id, phase: row.phase, iteration: row.iteration }));
      })
      .immediate();
  }

  runCount(taskId: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM task_runs WHERE task_id = ?").get(taskId) as { n: number }).n;
  }

  beat(now: Date, info: object): void {
    this.db
      .prepare("INSERT INTO runner_heartbeat (id, at, info_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, info_json = excluded.info_json")
      .run(now.toISOString(), JSON.stringify(info));
  }

  lastBeat(): string | undefined {
    return (this.db.prepare("SELECT at FROM runner_heartbeat WHERE id = 1").get() as { at: string } | undefined)?.at;
  }

  /** Stops the runner from starting new phases until `until`, for example to keep plan headroom for the chat. */
  holdAgents(until: Date, now: Date): void {
    this.db
      .prepare("INSERT INTO runner_heartbeat (id, at, info_json, hold_until) VALUES (1, ?, '{}', ?) ON CONFLICT(id) DO UPDATE SET hold_until = excluded.hold_until")
      .run(now.toISOString(), until.toISOString());
  }

  /** The end of the current hold, or undefined when agents may run. */
  agentsHeldUntil(now: Date): Date | undefined {
    const row = this.db.prepare("SELECT hold_until FROM runner_heartbeat WHERE id = 1").get() as { hold_until: string | null } | undefined;
    return row?.hold_until && Date.parse(row.hold_until) > now.getTime() ? new Date(row.hold_until) : undefined;
  }

  createApproval(taskId: string, kind: string, description: string, now: Date): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO task_approvals (id, task_id, kind, description, status, requested_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(id, taskId, kind, description, now.toISOString());
    return id;
  }

  /** Records the owner's decision once. Returns the approval description, or undefined if it was not pending. */
  decideApproval(approvalId: string, taskId: string, decision: "approved" | "rejected", now: Date): string | undefined {
    const row = this.db
      .prepare("SELECT description FROM task_approvals WHERE id = ? AND task_id = ? AND status = 'pending'")
      .get(approvalId, taskId) as { description: string } | undefined;
    if (!row) return undefined;
    const result = this.db
      .prepare("UPDATE task_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision, now.toISOString(), approvalId);
    return result.changes > 0 ? row.description : undefined;
  }

  addAttachment(attachment: Omit<Attachment, "taskId">, now: Date): void {
    this.db
      .prepare("INSERT INTO task_attachments (id, name, media_type, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(attachment.id, attachment.name, attachment.mediaType, attachment.size, attachment.sha256, now.toISOString());
  }

  attachments(taskId: string): Attachment[] {
    const rows = this.db
      .prepare("SELECT id, task_id, name, media_type, size, sha256 FROM task_attachments WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as { id: string; task_id: string; name: string; media_type: string; size: number; sha256: string }[];
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, name: row.name, mediaType: row.media_type, size: row.size, sha256: row.sha256 }));
  }

  unboundAttachments(ids: readonly string[]): string[] {
    return ids.filter((id) => this.db.prepare("SELECT 1 FROM task_attachments WHERE id = ? AND task_id IS NULL").get(id));
  }
}
