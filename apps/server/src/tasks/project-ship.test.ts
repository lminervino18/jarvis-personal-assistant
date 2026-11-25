import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMigratedDatabase, workMigrations } from "../db/database.js";
import { ShipError, type ProjectShipper } from "../projects/project-shipper.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "./task-store.js";
import { WorkLayout } from "./workspace.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(ship: ProjectShipper["ship"]) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-ship-"));
  dirs.push(root);
  const store = new TaskStore(openMigratedDatabase(":memory:", workMigrations));
  const service = new TaskService(store, new WorkLayout(root), { defaultBudgetUsd: 5, maxAttachmentBytes: 1024 }, undefined, { ship } as ProjectShipper);
  const now = new Date("2026-11-25T12:00:00Z");
  const created = service.create({ title: "Agregar login", request: "Agregá login con GitHub", target: { kind: "github", repo: "owner/app", base: "main" } }, now);
  if (!created.ok) throw new Error(created.message);
  const evidence = { iteration: 1, changedFiles: ["a.ts"], diffStat: "1 file", diffPath: "/work/tasks/x/.runner/iteration-1.diff" };
  const report = { status: "done" as const, summary: "Listo", changes: [], commandsRun: [], deliverables: [], criteria: [], questions: [], approvalsNeeded: [], commitTitle: "feat(auth): add GitHub login" };
  store.update(created.task.id, { status: "ready", phase: null, iteration: 1, evidence, report }, now);
  return { service, store, now, taskId: created.task.id };
}

describe("shipping a project task", () => {
  it("opens the pull request in the background and shows its link on the card", async () => {
    const ship = vi.fn<ProjectShipper["ship"]>(async (_task, _kind, _title, onStep) => {
      onStep("push");
      return { commit: "abc1234", url: "https://github.com/owner/app/pull/3", message: "Abrí el PR #3 en owner/app con la tarea #1." };
    });
    const { service, store, now, taskId } = setup(ship);
    expect(service.cardFor(taskId)).toMatchObject({ target: { kind: "github", repo: "owner/app" }, status: "ready" });

    expect(service.decide(taskId, "ship_new", undefined, now)).toMatchObject({ ok: false });
    expect(service.decide(taskId, "ship_pr", undefined, now)).toMatchObject({ ok: true, message: expect.stringContaining("abriendo el PR") });
    await vi.waitFor(() => expect(service.cardFor(taskId)?.publication).toMatchObject({ status: "published", url: "https://github.com/owner/app/pull/3" }));
    expect(ship).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), "pr", "feat(auth): add GitHub login", expect.any(Function));
    expect(store.events(taskId, 3).at(-1)).toMatchObject({ kind: "published", notify: true, message: expect.stringContaining("pull/3") });
    expect(store.activePublications()).toEqual([]);
  });

  it("records where it failed and lets the owner try again", async () => {
    const ship = vi.fn<ProjectShipper["ship"]>(async () => {
      throw new ShipError("push", "GitHub rechazó el push a main.");
    });
    const { service, now, taskId } = setup(ship);
    service.decide(taskId, "ship_main", undefined, now);
    await vi.waitFor(() => expect(service.cardFor(taskId)?.publication).toMatchObject({ status: "failed", step: "push", message: "GitHub rechazó el push a main." }));
    expect(service.decide(taskId, "ship_pr", undefined, now)).toMatchObject({ ok: true });
  });
});
