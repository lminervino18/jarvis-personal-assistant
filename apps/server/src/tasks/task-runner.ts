import { rmSync } from "node:fs";
import type { TaskBlocker } from "@jarvis/contracts";
import { retryableAgentErrors, type AgentBackend, type AgentRunRequest, type AgentRunResult } from "./agent-backend.js";
import { executorPrompt, plannerPrompt, reviewerPrompt, reviewFeedback } from "./prompts.js";
import { ExecutionReport, ReviewResult, TaskSpec } from "./schemas.js";
import type { Task, TaskPatch, TaskRun, TaskStore } from "./task-store.js";
import type { TaskPaths, WorkLayout } from "./workspace.js";

export interface TaskRunnerLimits {
  concurrency: number;
  runBudgetUsd: number;
  maxFixRounds: number;
  maxAttempts: number;
  /** Fraction of the subscription window agents may use before they pause until it resets; the rest stays for the chat. */
  planMaxUtilization: number;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  diffChars: number;
}

export const defaultRunnerLimits: TaskRunnerLimits = {
  concurrency: 1,
  runBudgetUsd: 2,
  maxFixRounds: 2,
  maxAttempts: 3,
  planMaxUtilization: 0.7,
  leaseMs: 120_000,
  heartbeatMs: 15_000,
  pollMs: 3_000,
  diffChars: 60_000,
};

export interface RunnerLogger {
  info(data: object, message?: string): void;
  warn(data: object, message?: string): void;
  error(data: object, message?: string): void;
}

export interface TaskRunnerDeps {
  store: TaskStore;
  layout: WorkLayout;
  backend: AgentBackend;
  limits: TaskRunnerLimits;
  log: RunnerLogger;
  /** Owner's time zone, for the times written in notifications. */
  timezone: string;
  now?: () => Date;
}

const MIN_RUN_BUDGET_USD = 0.05;
const RETRY_BASE_MS = 30_000;
const USAGE_LIMIT_WAIT_MS = 30 * 60_000;

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Drives delegated tasks through plan, execute and review. The model does the work inside
 * each phase; this class owns the queue, leases, limits, retries and every state change,
 * so a crash or a usage limit leaves the task resumable from the database.
 */
export class TaskRunner {
  private readonly active = new Map<string, ActiveRun>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly deps: TaskRunnerDeps) {}

  get activeRuns(): number {
    return this.active.size;
  }

  start(): void {
    this.recoverAfterRestart();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    for (const run of this.active.values()) run.controller.abort();
    await Promise.all([...this.active.values()].map((run) => run.done));
  }

  /** Every run left `running` by a previous process is interrupted and its task re-queued. */
  recoverAfterRestart(): void {
    this.recover(new Date(this.now().getTime() + this.deps.limits.leaseMs + 1));
  }

  /** Expires dead leases and starts as many claimable tasks as the concurrency allows, unless agents are on hold. */
  tick(): void {
    const { store, limits } = this.deps;
    store.beat(this.now(), { backend: this.deps.backend.name, active: this.active.size });
    this.recover(this.now());
    if (store.agentsHeldUntil(this.now())) return;
    while (!this.stopping && this.active.size < limits.concurrency) {
      const claimed = store.claimNext(this.now(), limits.leaseMs);
      if (!claimed) return;
      const controller = new AbortController();
      const done = this.execute(claimed.task, claimed.run, controller).finally(() => this.active.delete(claimed.run.id));
      this.active.set(claimed.run.id, { controller, done });
    }
  }

  /** Runs ticks until nothing is running and nothing is claimable. For tests and one-shot demos. */
  async runUntilIdle(maxRuns = 50): Promise<void> {
    for (let i = 0; i < maxRuns; i++) {
      this.tick();
      if (this.active.size === 0) return;
      await Promise.all([...this.active.values()].map((run) => run.done));
    }
    throw new Error("runner did not become idle");
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      try {
        this.tick();
      } catch (error) {
        this.deps.log.error({ err: error instanceof Error ? error.message : "unknown" }, "runner tick failed");
      }
      this.schedule();
    }, this.deps.limits.pollMs);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private recover(until: Date): void {
    const { store, limits } = this.deps;
    for (const run of store.expireRuns(until)) {
      const task = store.get(run.taskId);
      if (task?.status !== "running") continue;
      const attempts = task.attempts + 1;
      if (attempts >= limits.maxAttempts) {
        this.fail(task, `Se interrumpió ${attempts} veces seguidas durante la fase ${run.phase}.`);
        continue;
      }
      store.update(task.id, { status: "queued", attempts }, this.now(), ["running"]);
      store.addEvent(task.id, "interrupted", `La fase ${run.phase} se interrumpió y se reintenta.`, false, this.now());
    }
  }

  private async execute(task: Task, run: TaskRun, controller: AbortController): Promise<void> {
    const { store, limits, log } = this.deps;
    const heartbeat = setInterval(() => {
      const current = store.get(task.id);
      if (!store.renewLease(run.id, this.now(), limits.leaseMs) || current?.status !== "running" || current.paused) controller.abort();
    }, limits.heartbeatMs);
    try {
      const paths = await this.deps.layout.prepare(task, store.attachments(task.id));
      store.addEvent(task.id, "phase_started", `Empezó la fase ${run.phase}.`, false, this.now());
      if (run.phase === "plan") await this.plan(task, run, paths, controller.signal);
      else if (run.phase === "execute") await this.executePhase(task, run, paths, controller.signal);
      else await this.review(task, run, paths, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      log.error({ taskId: task.id, phase: run.phase, err: message.slice(0, 200) }, "task phase crashed");
      store.finishRun(run, { status: "failed", models: [], costUsd: 0, turns: 0, errorCode: "internal", errorMessage: message }, this.now());
      this.handleFailure(task, run, { costUsd: 0, turns: 0, models: [], error: { code: "internal", message } });
    } finally {
      clearInterval(heartbeat);
      store.finishRun(run, { status: "interrupted", models: [], costUsd: 0, turns: 0, errorCode: "skipped" }, this.now());
    }
  }

  private remainingBudget(task: Task): number {
    const current = this.deps.store.get(task.id) ?? task;
    return current.budgetUsd - current.costUsd;
  }

  /** Runs one agent session, or refuses it when the task has no budget left. Always closes the run. */
  private async runAgent(task: Task, run: TaskRun, request: Omit<AgentRunRequest, "maxBudgetUsd">): Promise<AgentRunResult> {
    const remaining = this.remainingBudget(task);
    const result: AgentRunResult =
      remaining < MIN_RUN_BUDGET_USD
        ? { costUsd: 0, turns: 0, models: [], error: { code: "budget", message: "La tarea no tiene presupuesto disponible" } }
        : await this.deps.backend.run({ ...request, maxBudgetUsd: Math.min(this.deps.limits.runBudgetUsd, remaining) });
    this.deps.store.finishRun(
      run,
      {
        status: result.error ? (result.error.code === "cancelled" ? "interrupted" : "failed") : "succeeded",
        sessionId: result.sessionId,
        models: result.models,
        costUsd: result.costUsd,
        turns: result.turns,
        planUtilization: result.plan?.utilization,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
      },
      this.now(),
    );
    this.reservePlan(task, result);
    return result;
  }

  /**
   * Holds every agent until the subscription window resets when a session crossed the plan
   * reserve or hit the usage limit, so the remaining quota stays for the owner's chat.
   */
  private reservePlan(task: Task, result: AgentRunResult): void {
    const { store, limits } = this.deps;
    const now = this.now();
    const limited = result.error?.code === "usage_limit";
    const plan = result.plan;
    if (!limited && (!plan || plan.utilization < limits.planMaxUtilization)) return;
    const fallback = now.getTime() + USAGE_LIMIT_WAIT_MS;
    const until = new Date(limited ? now.getTime() + (result.error?.retryAfterMs ?? USAGE_LIMIT_WAIT_MS) : (plan?.resetsAt ?? fallback));
    const held = store.agentsHeldUntil(now);
    if (until <= now || (held && held >= until)) return;
    store.holdAgents(until, now);
    this.deps.log.info({ taskId: task.id, until: until.toISOString(), utilization: plan?.utilization }, "agents on hold for plan reserve");
    if (!limited && plan) {
      const percent = Math.round(plan.utilization * 100);
      store.addEvent(task.id, "plan_reserve", `Pausé los agentes hasta las ${this.clock(until)}: el plan va por el ${percent} % y el resto queda para vos.`, true, now);
    }
  }

  private clock(date: Date): string {
    const { timezone } = this.deps;
    const time = date.toLocaleTimeString("es-AR", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const day = date.toLocaleDateString("es-AR", { timeZone: timezone, weekday: "long" });
    return `${time} del ${day}`;
  }

  private dirs(paths: TaskPaths, cwd = paths.work) {
    return { cwd, readable: [paths.request, paths.context], forbiddenRoot: this.deps.layout.root };
  }

  private async plan(task: Task, run: TaskRun, paths: TaskPaths, signal: AbortSignal): Promise<void> {
    const answers = task.pendingFeedback.length ? `\n\nRespuestas y aclaraciones del dueño:\n${task.pendingFeedback.map((line) => `- ${line}`).join("\n")}` : "";
    const result = await this.runAgent(task, run, {
      role: "planner",
      taskId: task.id,
      prompt: plannerPrompt(task) + answers,
      dirs: this.dirs(paths),
      outputSchema: TaskSpec,
      signal,
    });
    const spec = result.error ? undefined : TaskSpec.safeParse(result.output);
    if (!spec?.success) return this.handleFailure(task, run, this.invalid(result));

    const questions = spec.data.blockingQuestions;
    if (questions.length > 0) {
      this.block(task, { spec: spec.data }, { kind: "question", message: questions.join("\n") }, "necesita una respuesta tuya");
      return;
    }
    this.advance(task, { spec: spec.data, phase: "execute" }, "planned", "Plan listo con criterios de aceptación.");
  }

  private async executePhase(task: Task, run: TaskRun, paths: TaskPaths, signal: AbortSignal): Promise<void> {
    const { store, layout } = this.deps;
    if (!task.spec) return this.advance(task, { phase: "plan" }, "replan", "Falta el plan; se vuelve a planificar.");
    const consumed = task.pendingFeedback.length;
    const guidance = [
      ...(task.review?.verdict === "changes" ? reviewFeedback(task.review) : []),
      ...task.pendingFeedback.map((line) => `Dueño: ${line}`),
    ];
    const result = await this.runAgent(task, run, {
      role: "executor",
      taskId: task.id,
      prompt: executorPrompt(task, task.spec, guidance, this.deps.backend.runsCommands),
      dirs: this.dirs(paths),
      outputSchema: ExecutionReport,
      resumeSessionId: task.executorSessionId,
      signal,
    });
    const report = result.error ? undefined : ExecutionReport.safeParse(result.output);
    if (!report?.success) return this.handleFailure(task, run, this.invalid(result));

    const iteration = task.iteration + 1;
    const evidence = await layout.snapshot(task.id, iteration);
    const current = store.require(task.id);
    const patch: TaskPatch = {
      report: report.data,
      evidence,
      iteration,
      executorSessionId: result.sessionId ?? null,
      pendingFeedback: current.pendingFeedback.slice(consumed),
    };
    const approval = report.data.approvalsNeeded[0];
    if (approval) {
      const approvalId = store.createApproval(task.id, approval.kind, approval.description, this.now());
      this.block(task, { ...patch, phase: "execute" }, { kind: "approval", message: approval.description, approvalId }, "necesita tu aprobación");
      return;
    }
    if (report.data.status === "blocked") {
      const message = report.data.questions.join("\n") || report.data.summary;
      this.block(task, { ...patch, phase: "execute" }, { kind: "question", message }, "necesita una respuesta tuya");
      return;
    }
    this.advance(task, { ...patch, phase: "review" }, "executed", `Iteración ${iteration} terminada; pasa a revisión.`);
  }

  private async review(task: Task, run: TaskRun, paths: TaskPaths, signal: AbortSignal): Promise<void> {
    const { layout, store, limits } = this.deps;
    if (!task.spec || !task.report || !task.evidence) return this.advance(task, { phase: "execute" }, "reexecute", "Falta el informe; se vuelve a ejecutar.");
    const reviewDir = await layout.reviewCopy(task.id, task.iteration);
    try {
      const result = await this.runAgent(task, run, {
        role: "reviewer",
        taskId: task.id,
        prompt: reviewerPrompt(task, task.spec, task.report, task.evidence, layout.diff(task.evidence, limits.diffChars), this.deps.backend.runsCommands),
        dirs: this.dirs(paths, reviewDir),
        outputSchema: ReviewResult,
        signal,
      });
      const review = result.error ? undefined : ReviewResult.safeParse(result.output);
      if (!review?.success) return this.handleFailure(task, run, this.invalid(result));

      const verdict = review.data;
      const current = store.require(task.id);
      if (verdict.verdict === "approve" && current.pendingFeedback.length > 0) {
        this.advance(task, { review: verdict, phase: "execute", fixRounds: 0 }, "reviewed", "Revisión aprobada, pero hay pedidos nuevos del dueño.");
      } else if (verdict.verdict === "approve") {
        this.settle(task, { review: verdict, phase: null, status: "ready", blocker: null }, "ready", `La tarea #${task.ref} está lista para revisar.`);
      } else if (verdict.verdict === "blocked") {
        this.block(task, { review: verdict, phase: "execute" }, { kind: "question", message: verdict.summary }, "necesita una respuesta tuya");
      } else if (task.fixRounds < limits.maxFixRounds) {
        this.advance(task, { review: verdict, phase: "execute", fixRounds: task.fixRounds + 1 }, "changes_requested", "El revisor pidió cambios; se corrige.");
      } else {
        const message = `No pasó la revisión después de ${task.fixRounds} correcciones. ${verdict.summary}`;
        this.block(task, { review: verdict, phase: "execute" }, { kind: "review_limit", message }, "no pasó la revisión");
      }
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  }

  private invalid(result: AgentRunResult): AgentRunResult {
    return result.error ? result : { ...result, error: { code: "invalid_output", message: "El informe no respeta el formato esperado" } };
  }

  private advance(task: Task, patch: TaskPatch, kind: string, message: string): void {
    const { store } = this.deps;
    if (store.update(task.id, { ...patch, status: "queued", attempts: 0, notBefore: null, blocker: null }, this.now(), ["running"])) {
      store.addEvent(task.id, kind, message, false, this.now());
    }
  }

  private block(task: Task, patch: TaskPatch, blocker: TaskBlocker, what: string): void {
    this.settle(task, { ...patch, status: "awaiting_owner", blocker }, blocker.kind, `La tarea #${task.ref} ${what}.`);
  }

  private settle(task: Task, patch: TaskPatch, kind: string, message: string): void {
    const { store } = this.deps;
    if (store.update(task.id, { ...patch, attempts: 0, notBefore: null }, this.now(), ["running"])) {
      store.addEvent(task.id, kind, message, true, this.now());
    }
  }

  private fail(task: Task, message: string): void {
    const { store } = this.deps;
    const patch: TaskPatch = { status: "failed", blocker: { kind: "error", message }, finishedAt: this.now().toISOString() };
    if (store.update(task.id, patch, this.now(), ["running", "queued"])) {
      store.addEvent(task.id, "failed", `La tarea #${task.ref} falló.`, true, this.now(), { message });
    }
  }

  private handleFailure(task: Task, run: TaskRun, result: AgentRunResult): void {
    const { store, limits, log } = this.deps;
    const error = result.error ?? { code: "internal" as const, message: "unknown" };
    log.warn({ taskId: task.id, phase: run.phase, code: error.code }, "task phase failed");
    const current = store.get(task.id);
    if (!current || current.status !== "running") return;

    if (error.code === "cancelled") {
      store.update(task.id, { status: "queued" }, this.now(), ["running"]);
      store.addEvent(task.id, "paused", `La fase ${run.phase} se detuvo.`, false, this.now());
      return;
    }
    if (error.code === "budget") {
      this.block(task, {}, { kind: "budget", message: `Llegó al presupuesto de USD ${current.budgetUsd.toFixed(2)}.` }, "llegó a su presupuesto");
      return;
    }
    const attempts = current.attempts + 1;
    if (error.code === "usage_limit") {
      if (attempts >= limits.maxAttempts) {
        this.block(task, {}, { kind: "usage_limit", message: "Claude sigue sin cuota disponible." }, "está frenada por el límite de uso");
        return;
      }
      const notBefore = new Date(this.now().getTime() + (error.retryAfterMs ?? USAGE_LIMIT_WAIT_MS));
      store.update(task.id, { status: "queued", attempts, notBefore: notBefore.toISOString() }, this.now(), ["running"]);
      store.addEvent(task.id, "usage_limit", `Se agotó el uso del plan; la tarea sigue a las ${this.clock(notBefore)}.`, attempts === 1, this.now());
      return;
    }
    if (retryableAgentErrors.has(error.code) || error.code === "invalid_output") {
      if (attempts >= limits.maxAttempts) return this.fail(current, `${error.code}: ${error.message}`);
      const notBefore = new Date(this.now().getTime() + RETRY_BASE_MS * 2 ** (attempts - 1)).toISOString();
      const patch: TaskPatch = { status: "queued", attempts, notBefore, ...(error.code === "resume_failed" ? { executorSessionId: null } : {}) };
      store.update(task.id, patch, this.now(), ["running"]);
      store.addEvent(task.id, "retry", `Falló la fase ${run.phase} (${error.code}); reintento ${attempts}.`, false, this.now());
      return;
    }
    const messages: Record<string, string> = {
      max_turns: "El agente agotó los turnos permitidos sin terminar.",
      auth: "Las credenciales de Claude para los agentes no son válidas.",
      model_policy: error.message,
    };
    this.block(task, {}, { kind: "error", message: messages[error.code] ?? error.message }, "se frenó por un error");
  }
}
