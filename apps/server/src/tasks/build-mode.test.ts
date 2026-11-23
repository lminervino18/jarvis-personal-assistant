import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, workMigrations } from "../db/database.js";
import { BUILD_PROJECT, PublicationSpool, PublishRequest, verifyRequest } from "../publisher/spool.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "./task-store.js";
import { WorkLayout } from "./workspace.js";

const KEY = "k".repeat(64);
const PATCH = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hola\n+chau\n";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { project?: boolean; spool?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-build-"));
  dirs.push(root);
  const workDir = join(root, "work");
  if (options.project !== false) {
    mkdirSync(join(workDir, "projects", BUILD_PROJECT), { recursive: true });
    writeFileSync(join(workDir, "projects", BUILD_PROJECT, "CONTEXT.md"), "# JARVIS\n");
  }
  const publishDir = join(root, "publish");
  if (options.spool !== false) {
    mkdirSync(join(publishDir, "requests"), { recursive: true });
    mkdirSync(join(publishDir, "results"), { recursive: true });
  }
  const store = new TaskStore(openMigratedDatabase(":memory:", workMigrations));
  const layout = new WorkLayout(workDir);
  const spool = new PublicationSpool(publishDir, KEY);
  const service = new TaskService(store, layout, { defaultBudgetUsd: 5, maxAttachmentBytes: 1024 }, spool);
  const now = new Date("2026-11-22T12:00:00Z");

  const readyBuild = (text = "Agregá un saludo en el README") => {
    const outcome = service.createBuild(text, now);
    if (!outcome.ok) throw new Error(outcome.message);
    const runnerDir = layout.paths(outcome.task.id).runner;
    mkdirSync(runnerDir, { recursive: true });
    writeFileSync(join(runnerDir, "iteration-1.diff"), PATCH);
    const evidence = { iteration: 1, changedFiles: ["README.md"], diffStat: "1 file", diffPath: "/srv/jarvis/work/tasks/x/.runner/iteration-1.diff" };
    const report = { status: "done" as const, summary: "Listo", changes: [], commandsRun: [], deliverables: [], criteria: [], questions: [], approvalsNeeded: [], commitTitle: "docs: greet in the readme" };
    store.update(outcome.task.id, { status: "ready", phase: null, iteration: 1, evidence, report }, now);
    return store.require(outcome.task.id);
  };
  const writeResult = (id: string, result: object) => writeFileSync(join(publishDir, "results", `${id}.json`), JSON.stringify({ id, at: now.toISOString(), ...result }));
  return { store, layout, service, spool, publishDir, now, readyBuild, writeResult };
}

describe("build mode", () => {
  it("turns a request into a task on the jarvis project without the model", () => {
    const { service } = setup();
    const outcome = service.createBuild("Agregá un botón para repetir la última respuesta\ncon detalles", new Date());
    expect(outcome).toMatchObject({ ok: true, task: { project: BUILD_PROJECT, source: "build", title: "Agregá un botón para repetir la última respuesta", status: "queued" } });
    expect(service.buildCards()).toMatchObject([{ build: true, status: "queued" }]);
  });

  it("refuses build requests while the jarvis project is not installed", () => {
    const { service } = setup({ project: false });
    expect(service.createBuild("algo", new Date())).toMatchObject({ ok: false });
  });

  it("publishes a reviewed change as a signed request with the exact patch", () => {
    const { service, spool, publishDir, now, readyBuild, store } = setup();
    const task = readyBuild();
    const outcome = service.decide(task.id, "publish", undefined, now);
    expect(outcome).toMatchObject({ ok: true, task: { status: "accepted" } });

    const files = readdirSync(join(publishDir, "requests")).sort();
    expect(files.filter((name) => !name.startsWith("."))).toHaveLength(2);
    const request = PublishRequest.parse(JSON.parse(readFileSync(join(publishDir, "requests", files.find((name) => name.endsWith(".json"))!), "utf8")));
    expect(request).toMatchObject({ taskRef: task.ref, commitTitle: "docs: greet in the readme" });
    expect(verifyRequest(KEY, request)).toBe(true);
    expect(verifyRequest("x".repeat(64), request)).toBe(false);
    expect(readFileSync(join(publishDir, "requests", `${request.id}.patch`), "utf8")).toBe(PATCH);
    expect(service.card(store.require(task.id)).publication).toEqual({ status: "queued" });
    expect(spool.available()).toBe(true);
  });

  it("runs one publication at a time and only for reviewed jarvis tasks", () => {
    const { service, now, readyBuild, store } = setup();
    const first = readyBuild();
    const second = readyBuild("Otro cambio");
    expect(service.publish(first.id, now).ok).toBe(true);
    expect(service.publish(second.id, now)).toMatchObject({ ok: false, message: expect.stringContaining("en curso") });

    const other = store.create({ title: "otra", request: "otra", budgetUsd: 5 }, now);
    expect(service.publish(other.id, now)).toMatchObject({ ok: false, message: expect.stringContaining("JARVIS") });
  });

  it("falls back to a safe commit title when the executor did not propose a valid one", () => {
    const { service, publishDir, now, readyBuild, store } = setup();
    const task = readyBuild();
    store.update(task.id, { report: { ...task.report!, commitTitle: "Agregué un saludo\nCo-Authored-By: x" } }, now);
    service.publish(task.id, now);
    const name = readdirSync(join(publishDir, "requests")).find((file) => file.endsWith(".json") && !file.startsWith("."))!;
    expect(JSON.parse(readFileSync(join(publishDir, "requests", name), "utf8")).commitTitle).toBe(`feat(build): apply build task ${task.ref}`);
  });

  it("refuses to publish when the publisher is not configured", () => {
    const { service, now, readyBuild } = setup({ spool: false });
    expect(service.publish(readyBuild().id, now)).toMatchObject({ ok: false, message: expect.stringContaining("no está configurada") });
  });

  it("follows the publisher's results and tells the owner once when it ends", () => {
    const { service, now, readyBuild, store, writeResult } = setup();
    const task = readyBuild();
    service.publish(task.id, now);
    const publication = store.publication(task.id)!;

    writeResult(publication.id, { status: "running", step: "checks" });
    service.syncPublications(now);
    expect(store.publication(task.id)).toMatchObject({ status: "running", step: "checks" });

    writeResult(publication.id, { status: "published", step: "deploy", commit: "abc1234" });
    service.syncPublications(now);
    service.syncPublications(now);
    expect(service.card(store.require(task.id)).publication).toEqual({ status: "published", step: "deploy", commit: "abc1234" });
    const notified = store.notifiableEvents(0).filter((event) => event.kind === "published");
    expect(notified).toHaveLength(1);
    expect(notified[0]?.message).toContain("commit abc1234");
  });

  it("lets the owner publish again after a failed publication, and only then", () => {
    const { service, now, readyBuild, store, writeResult } = setup();
    const task = readyBuild();
    service.publish(task.id, now);
    expect(service.publish(task.id, now)).toMatchObject({ ok: false });
    writeResult(store.publication(task.id)!.id, { status: "failed", step: "checks", message: "No pasó lint, typecheck, tests o build" });
    service.syncPublications(now);
    expect(store.require(task.id).status).toBe("accepted");

    expect(service.publish(task.id, now)).toMatchObject({ ok: true });
    expect(store.publication(task.id)).toMatchObject({ status: "queued" });
  });

  it("reports a publisher that never answered", () => {
    const { service, now, readyBuild, store } = setup();
    const task = readyBuild();
    service.publish(task.id, now);
    service.syncPublications(new Date(now.getTime() + 3 * 3_600_000));
    expect(store.publication(task.id)).toMatchObject({ status: "failed", step: "publisher" });
  });

  it("starts a new build when the owner writes about one already published", () => {
    const { service, now, readyBuild } = setup();
    const task = readyBuild();
    service.publish(task.id, now);
    const outcome = service.buildFeedback(task.id, "ahora cambiá el color", now);
    expect(outcome).toMatchObject({ ok: true, task: { status: "queued" } });
    expect(outcome.ok && outcome.task.id).not.toBe(task.id);
  });
});
