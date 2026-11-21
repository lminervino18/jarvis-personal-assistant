import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, workMigrations } from "../db/database.js";
import { registerTaskRoutes } from "./task-routes.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "./task-store.js";
import { WorkLayout } from "./workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const workDir = mkdtempSync(join(tmpdir(), "jarvis-routes-"));
  dirs.push(workDir);
  const store = new TaskStore(openMigratedDatabase(join(workDir, "work.db"), workMigrations));
  const layout = new WorkLayout(workDir);
  const service = new TaskService(store, layout, { defaultBudgetUsd: 5, maxAttachmentBytes: 1024 });
  const app = Fastify();
  registerTaskRoutes(app, { requireOwner: (request) => request.headers["x-owner"] === "yes" }, service, layout, 1024);
  await app.ready();
  const created = service.create({ title: "Tarea de prueba", request: "un pedido de prueba sintético" }, new Date());
  if (!created.ok) throw new Error(created.message);
  const work = layout.paths(created.task.id).work;
  mkdirSync(join(work, ".git"), { recursive: true });
  writeFileSync(join(work, "CHANGES.md"), "# Cambios");
  writeFileSync(join(work, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(work, "data.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(work, ".git", "config"), "[core]");
  writeFileSync(join(workDir, "secret.txt"), "no");
  return { app, service, owner: { "x-owner": "yes" } };
}

describe("task routes", () => {
  it("accepts attachments only from the owner and within the size limit", async () => {
    const { app, owner } = await setup();
    const upload = (headers: Record<string, string>, body: Buffer) =>
      app.inject({ method: "POST", url: "/api/tasks/attachments?name=captura.png", headers: { "content-type": "image/png", ...headers }, payload: body });
    expect((await upload({}, Buffer.from("png"))).statusCode).toBe(401);
    const ok = await upload(owner, Buffer.from("png"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: "captura.png", size: 3, mediaType: "image/png" });
    expect((await upload(owner, Buffer.alloc(2048))).statusCode).toBe(413);
    const json = await app.inject({ method: "POST", url: "/api/tasks/attachments?name=datos.json", headers: { "content-type": "application/json", ...owner }, payload: "{\"a\":1}" });
    expect(json.json()).toMatchObject({ name: "datos.json", size: 7, mediaType: "application/json" });
  });

  it("serves deliverables as inert content and never outside the task's work folder", async () => {
    const { app, owner } = await setup();
    const file = (path: string, headers = owner) => app.inject({ method: "GET", url: `/api/tasks/1/files?path=${encodeURIComponent(path)}`, headers });
    expect((await file("CHANGES.md", {} as typeof owner)).statusCode).toBe(401);
    const text = await file("CHANGES.md");
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect((await file("page.html")).headers["content-type"]).toBe("text/plain; charset=utf-8");
    const binary = await file("data.bin");
    expect(binary.headers["content-type"]).toBe("application/octet-stream");
    expect(binary.headers["content-disposition"]).toBe("attachment");
    expect((await file("../../../secret.txt")).statusCode).toBe(404);
    expect((await file(".git/config")).statusCode).toBe(404);
    expect((await file("/etc/hostname")).statusCode).toBe(404);
  });

  it("returns 404 for a diff before the first execution", async () => {
    const { app, owner } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/tasks/1/diff", headers: owner })).statusCode).toBe(404);
  });
});
