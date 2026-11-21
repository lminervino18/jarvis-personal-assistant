import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, ToolResult, ToolSuccess } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, workMigrations, type Db } from "../db/database.js";
import { toolsByName } from "../tools/index.js";
import { runTool } from "../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../tools/types.js";
import type { AgentRole } from "./agent-backend.js";
import { checkControlledCriteria, controlledAgents, CONTROLLED_TASK, seedFixtureProjects } from "./controlled-scenario.js";
import { ScriptedAgentBackend, type ScriptedHandler } from "./scripted-agent-backend.js";
import { TaskNotifier } from "./task-notifier.js";
import { defaultRunnerLimits, TaskRunner, type TaskRunnerLimits } from "./task-runner.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "./task-store.js";
import { WorkLayout } from "./workspace.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(handlers: Partial<Record<AgentRole, ScriptedHandler>> = controlledAgents(), limits: Partial<TaskRunnerLimits> = {}, budgetUsd = 5) {
  const workDir = mkdtempSync(join(tmpdir(), "jarvis-work-"));
  dirs.push(workDir);
  seedFixtureProjects(workDir);
  const clock = { now: new Date("2026-11-20T15:00:00Z") };
  const workDb: Db = openMigratedDatabase(join(workDir, "work.db"), workMigrations);
  const personalDb: Db = openMigratedDatabase(":memory:");
  personalDb.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('conv-1', ?, ?)").run(clock.now.toISOString(), clock.now.toISOString());
  const store = new TaskStore(workDb);
  const layout = new WorkLayout(workDir);
  const service = new TaskService(store, layout, { defaultBudgetUsd: budgetUsd, maxAttachmentBytes: 1024 * 1024 });
  const backend = new ScriptedAgentBackend(handlers);
  const makeRunner = () => new TaskRunner({ store, layout, backend, limits: { ...defaultRunnerLimits, ...limits }, log: silent, timezone: "America/Argentina/Buenos_Aires", now: () => clock.now });
  const cards: Card[] = [];
  const ctx: ToolContext = {
    services: { db: personalDb, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], tasks: service },
    conversationId: "conv-1",
    turnId: "turn-1",
    now: () => clock.now,
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  const tool = (name: string, input: object, overrides: Partial<ToolContext> = {}) =>
    runTool({ ...ctx, ...overrides }, toolsByName.get(name as never) as AnyToolDefinition, input);
  return { workDir, clock, workDb, personalDb, store, layout, service, backend, makeRunner, cards, tool };
}

function items<T = Record<string, unknown>>(result: ToolResult<unknown>): T[] {
  expect(result.ok).toBe(true);
  return (result as ToolSuccess<T>).items;
}

describe("controlled task, end to end with scripted agents", () => {
  it("plans, executes, gets rejected with real evidence, fixes and ends ready for the owner", async () => {
    const env = setup();
    const created = items<{ ref: number; status: string }>(await env.tool("task_create", CONTROLLED_TASK));
    expect(created[0]).toMatchObject({ ref: 1, status: "queued" });
    expect(env.cards.at(-1)).toMatchObject({ kind: "task", ref: 1, status: "queued" });

    await env.makeRunner().runUntilIdle();

    const task = env.service.byRef(1)!;
    expect(task.status).toBe("ready");
    expect(task.iteration).toBe(2);
    expect(task.fixRounds).toBe(1);
    expect(task.review?.verdict).toBe("approve");
    expect(task.review?.criteria.map((criterion) => criterion.status)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(env.backend.calls.map((call) => call.role)).toEqual(["planner", "executor", "reviewer", "executor", "reviewer"]);
    expect(env.backend.calls[3]?.resumeSessionId).toBe(`scripted-executor-${task.id.slice(0, 8)}`);
    expect(task.evidence?.changedFiles.sort()).toEqual(["CHANGES.md", "src/totals.mjs", "test/totals.test.mjs"]);
    expect(task.costUsd).toBeCloseTo(0.05);

    const rejection = env.store.events(task.id, 50).find((event) => event.kind === "changes_requested");
    expect(rejection?.message).toMatch(/pidió cambios/);
    expect(checkControlledCriteria(env.layout.paths(task.id).work).every((check) => check.pass)).toBe(true);

    const result = items<{ criteria: { id: string; review: string }[]; reviewVerdict: string }>(await env.tool("task_result", { ref: 1 }));
    expect(result[0]?.reviewVerdict).toBe("approve");
    expect(result[0]?.criteria.map((criterion) => criterion.review)).toEqual(["pass", "pass", "pass", "pass"]);
  });

  it("queues one chat message and one push per notifiable event, exactly once", async () => {
    const env = setup();
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    const notifier = new TaskNotifier(env.personalDb, env.store);
    expect(notifier.runOnce(env.clock.now)).toBe(1);
    expect(notifier.runOnce(env.clock.now)).toBe(0);
    const rows = env.personalDb.prepare("SELECT kind, payload_json FROM outbox ORDER BY kind").all() as { kind: string; payload_json: string }[];
    expect(rows.map((row) => row.kind)).toEqual(["chat_message", "push"]);
    const push = JSON.parse(rows[1]!.payload_json) as { body: string };
    expect(push.body).toBe("La tarea #1 está lista para revisar.");
    expect(push.body).not.toMatch(/descuento/);
    const chat = JSON.parse(rows[0]!.payload_json) as { cards: Card[] };
    expect(chat.cards[0]).toMatchObject({ kind: "task", status: "ready", review: { verdict: "approve", passed: 4, total: 4 } });
  });

  it("lets the owner accept the delivery from the card, and only from ready", async () => {
    const env = setup();
    await env.tool("task_create", CONTROLLED_TASK);
    const task = env.service.byRef(1)!;
    expect(env.service.decide(task.id, "accept", undefined, env.clock.now).ok).toBe(false);
    await env.makeRunner().runUntilIdle();
    const accepted = env.service.decide(task.id, "accept", undefined, env.clock.now);
    expect(accepted.ok && accepted.task.status).toBe("accepted");
  });
});

describe("continuity and limits", () => {
  it("recovers a phase whose process died and never runs two phases of a task at once", async () => {
    const env = setup();
    await env.tool("task_create", CONTROLLED_TASK);
    const claimed = env.store.claimNext(env.clock.now, defaultRunnerLimits.leaseMs);
    expect(claimed?.run.phase).toBe("plan");
    expect(env.store.claimNext(env.clock.now, defaultRunnerLimits.leaseMs)).toBeUndefined();

    const runner = env.makeRunner();
    runner.recoverAfterRestart();
    const task = env.service.byRef(1)!;
    expect(task).toMatchObject({ status: "queued", phase: "plan", attempts: 1 });
    await runner.runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("ready");
    expect(env.store.runCount(task.id)).toBe(6);
  });

  it("asks the owner when a planner question blocks, and replans with the answer", async () => {
    const answers: string[] = [];
    const base = controlledAgents();
    const env = setup({
      ...base,
      planner: (request, call) => {
        if (call === 1) return { output: { goal: "x", deliverables: [], acceptanceCriteria: [{ id: "C1", text: "x", verification: "x" }], assumptions: [], blockingQuestions: ["¿Qué IVA aplica?"], externalEffects: [] } };
        answers.push(request.prompt);
        return base.planner!(request, call);
      },
    });
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    expect(env.service.byRef(1)).toMatchObject({ status: "awaiting_owner", phase: "plan", blocker: { kind: "question", message: "¿Qué IVA aplica?" } });

    items(await env.tool("task_feedback", { ref: 1, message: "IVA 21 %" }));
    await env.makeRunner().runUntilIdle();
    expect(answers[0]).toContain("IVA 21 %");
    expect(env.service.byRef(1)?.status).toBe("ready");
  });

  it("stops at the task budget and resumes only when the owner adds budget", async () => {
    const env = setup(controlledAgents(), {}, 0.04);
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    const blocked = env.service.byRef(1)!;
    expect(blocked).toMatchObject({ status: "awaiting_owner", blocker: { kind: "budget" } });
    expect(env.service.control(1, "resume", undefined, env.clock.now).ok).toBe(false);
    expect(env.service.control(1, "resume", 1, env.clock.now).ok).toBe(true);
    await env.makeRunner().runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("ready");
  });

  it("waits out a usage limit without retrying early, then continues", async () => {
    const base = controlledAgents();
    const env = setup({
      ...base,
      executor: (request, call) => (call === 1 ? { error: { code: "usage_limit", message: "limit", retryAfterMs: 60 * 60_000 } } : base.executor!(request, call - 1)),
    });
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    const waiting = env.service.byRef(1)!;
    expect(waiting).toMatchObject({ status: "queued", phase: "execute", attempts: 1, notBefore: "2026-11-20T16:00:00.000Z" });
    expect(env.store.notifiableEvents(0).map((event) => event.kind)).toEqual(["usage_limit"]);
    expect(env.service.agentsHeldUntil(env.clock.now)?.toISOString()).toBe("2026-11-20T16:00:00.000Z");

    env.clock.now = new Date("2026-11-20T16:00:01Z");
    await env.makeRunner().runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("ready");
  });

  it("pauses every agent at the plan reserve, tells the owner once and resumes when the window resets", async () => {
    const base = controlledAgents();
    const plan = { utilization: 0.72, resetsAt: Date.parse("2026-11-20T17:00:00Z") };
    const env = setup({ ...base, planner: async (request, call) => ({ ...(await base.planner!(request, call)), plan }) });
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();

    expect(env.backend.calls.map((call) => call.role)).toEqual(["planner"]);
    expect(env.service.byRef(1)).toMatchObject({ status: "queued", phase: "execute" });
    expect(env.service.agentsHeldUntil(env.clock.now)?.toISOString()).toBe("2026-11-20T17:00:00.000Z");
    const notices = env.store.notifiableEvents(0);
    expect(notices.map((event) => event.kind)).toEqual(["plan_reserve"]);
    expect(notices[0]?.message).toBe("Pausé los agentes hasta las 14:00 del viernes: el plan va por el 72 % y el resto queda para vos.");
    expect(env.workDb.prepare("SELECT plan_utilization FROM task_runs").pluck().get()).toBe(0.72);

    const second = env.service.create({ ...CONTROLLED_TASK, title: "Segunda tarea" }, env.clock.now);
    expect(second.ok && second.message).toContain("en pausa");
    await env.makeRunner().runUntilIdle();
    expect(env.backend.calls).toHaveLength(1);

    env.clock.now = new Date("2026-11-20T17:00:01Z");
    await env.makeRunner().runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("ready");
    expect(env.backend.calls.some((call) => second.ok && call.taskId === second.task.id && call.role === "planner")).toBe(true);
    expect(env.store.notifiableEvents(0).filter((event) => event.kind === "plan_reserve")).toHaveLength(1);
  });

  it("retries transient failures with backoff and fails after the last attempt", async () => {
    const env = setup({ ...controlledAgents(), executor: () => ({ error: { code: "unavailable", message: "overloaded" } }) }, { maxAttempts: 2 });
    await env.tool("task_create", CONTROLLED_TASK);
    const runner = env.makeRunner();
    await runner.runUntilIdle();
    expect(env.service.byRef(1)).toMatchObject({ status: "queued", attempts: 1, notBefore: "2026-11-20T15:00:30.000Z" });
    env.clock.now = new Date("2026-11-20T15:01:00Z");
    await runner.runUntilIdle();
    expect(env.service.byRef(1)).toMatchObject({ status: "failed", blocker: { kind: "error" } });
  });

  it("stops a running phase when the owner cancels it", async () => {
    const env = setup(
      {
        ...controlledAgents(),
        planner: (request) =>
          new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ error: { code: "cancelled", message: "stop" } }))),
      },
      { heartbeatMs: 5 },
    );
    await env.tool("task_create", CONTROLLED_TASK);
    const runner = env.makeRunner();
    runner.tick();
    expect(runner.activeRuns).toBe(1);
    expect(env.service.control(1, "cancel", undefined, env.clock.now).ok).toBe(true);
    await runner.runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("cancelled");
    expect(env.backend.calls.map((call) => call.role)).toEqual(["planner"]);
  });

  it("does not claim a paused task until it is resumed", async () => {
    const env = setup();
    await env.tool("task_create", CONTROLLED_TASK);
    expect(env.service.control(1, "pause", undefined, env.clock.now).ok).toBe(true);
    await env.makeRunner().runUntilIdle();
    expect(env.backend.calls).toHaveLength(0);
    env.service.control(1, "resume", undefined, env.clock.now);
    await env.makeRunner().runUntilIdle();
    expect(env.service.byRef(1)?.status).toBe("ready");
  });

  it("blocks on an approval until the owner taps it, and passes the decision to the executor", async () => {
    const base = controlledAgents();
    const prompts: string[] = [];
    const env = setup({
      ...base,
      executor: (request, call) => {
        prompts.push(request.prompt);
        if (call === 1) {
          return { output: { status: "done", summary: "Listo para desplegar", changes: [], commandsRun: [], deliverables: [], criteria: [], questions: [], approvalsNeeded: [{ kind: "deploy", description: "Desplegar a staging" }] } };
        }
        return base.executor!(request, call - 1);
      },
    });
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    const blocked = env.service.byRef(1)!;
    expect(blocked).toMatchObject({ status: "awaiting_owner", blocker: { kind: "approval", message: "Desplegar a staging" } });

    const approvalId = blocked.blocker!.approvalId!;
    expect(env.service.decide(blocked.id, "approve", "00000000-0000-4000-8000-000000000000", env.clock.now).ok).toBe(false);
    expect(env.service.decide(blocked.id, "reject", approvalId, env.clock.now).ok).toBe(true);
    expect(env.service.decide(blocked.id, "approve", approvalId, env.clock.now).ok).toBe(false);
    await env.makeRunner().runUntilIdle();
    expect(prompts[1]).toContain("El dueño rechazó: Desplegar a staging");
    expect(env.service.byRef(1)?.status).toBe("ready");
  });

  it("takes owner feedback sent while the task runs into the next iteration", async () => {
    const base = controlledAgents();
    const prompts: string[] = [];
    const env: ReturnType<typeof setup> = setup({
      ...base,
      executor: (request, call) => {
        prompts.push(request.prompt);
        if (call === 1) env.service.feedback(1, "Usá nombres de prueba en español", env.clock.now);
        return base.executor!(request, call);
      },
    });
    await env.tool("task_create", CONTROLLED_TASK);
    await env.makeRunner().runUntilIdle();
    expect(prompts[1]).toContain("Dueño: Usá nombres de prueba en español");
    expect(env.service.byRef(1)?.pendingFeedback).toEqual([]);
  });
});

describe("task tools and the untrusted-content policy", () => {
  it("asks for confirmation before creating a task in a turn that read third-party content", async () => {
    const env = setup();
    const result = await env.tool("task_create", CONTROLLED_TASK, { security: { tainted: true, taintSources: new Set(["gmail_get_thread"]) } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("needs_confirmation");
    expect(env.service.list("all", 10)).toHaveLength(0);
  });

  it("marks the turn as tainted after reading a task result", async () => {
    const env = setup();
    await env.tool("task_create", CONTROLLED_TASK);
    const security = { tainted: false, taintSources: new Set<string>() };
    await env.tool("task_result", { ref: 1 }, { security });
    expect(security.tainted).toBe(true);
  });

  it("rejects an unknown project and lists the available ones", async () => {
    const env = setup();
    const result = await env.tool("task_create", { ...CONTROLLED_TASK, project: "no-existe" });
    expect(!result.ok && result.error.code).toBe("not_found");
    expect(items<{ slug: string }>(await env.tool("task_projects", {})).map((project) => project.slug)).toEqual(["facturacion-demo"]);
  });

  it("binds uploaded attachments to the task and copies them into its request folder", async () => {
    const env = setup();
    const attachment = env.service.saveAttachment({ name: "../captura.png", mediaType: "image/png", data: Buffer.from("fake-png") }, env.clock.now)!;
    expect(attachment.name).toBe("captura.png");
    items(await env.tool("task_create", { ...CONTROLLED_TASK, attachmentIds: [attachment.id] }));
    const task = env.service.byRef(1)!;
    expect(env.service.attachments(task).map((item) => item.id)).toEqual([attachment.id]);
    const second = await env.tool("task_create", { ...CONTROLLED_TASK, title: "Otra tarea", attachmentIds: [attachment.id] });
    expect(second.ok).toBe(false);
    const paths = await env.layout.prepare(task, env.service.attachments(task));
    expect(paths.request).toContain(task.id);
  });

  it("returns the same task when an external source ingests the same reference twice", () => {
    const env = setup();
    const first = env.store.create({ title: "Ticket 42", request: "pedido desde la app de la empresa", source: "company", externalRef: "42", budgetUsd: 5 }, env.clock.now);
    const again = env.store.create({ title: "Ticket 42", request: "pedido desde la app de la empresa", source: "company", externalRef: "42", budgetUsd: 5 }, env.clock.now);
    expect(again.id).toBe(first.id);
    expect(env.service.list("all", 10)).toHaveLength(1);
  });
});
