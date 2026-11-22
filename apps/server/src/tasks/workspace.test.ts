import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "./task-store.js";
import { WorkLayout } from "./workspace.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("review diff", () => {
  it("covers only what changed since the last review and skips lockfiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-layout-"));
    dirs.push(root);
    const layout = new WorkLayout(root);
    const task = { id: "t1", title: "t", request: "r" } as Task;
    const paths = await layout.prepare(task, []);

    writeFileSync(join(paths.work, "a.txt"), "first\n");
    writeFileSync(join(paths.work, "pnpm-lock.yaml"), "lock: 1\n");
    const first = await layout.snapshot(task.id, 1);
    await layout.markReviewed(task.id);
    writeFileSync(join(paths.work, "b.txt"), "second\n");
    const second = await layout.snapshot(task.id, 2);

    const firstDiff = layout.reviewDiff(task.id, first, 10_000);
    expect(firstDiff).toContain("a.txt");
    expect(firstDiff).not.toContain("pnpm-lock.yaml");
    const secondDiff = layout.reviewDiff(task.id, second, 10_000);
    expect(secondDiff).toContain("b.txt");
    expect(secondDiff).not.toContain("a.txt");
    expect(layout.diff(task.id, second, 10_000)).toContain("a.txt");
    expect(layout.diff(task.id, { ...second, diffPath: "/another/mount/tasks/t1/.runner/iteration-2.diff" }, 10_000)).toContain("a.txt");
    expect(layout.reviewDiff(task.id, second, 20)).toContain("diff recortado");
  });

  it("keeps iterations that were never reviewed in the next review diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-layout-"));
    dirs.push(root);
    const layout = new WorkLayout(root);
    const task = { id: "t2", title: "t", request: "r" } as Task;
    const paths = await layout.prepare(task, []);

    writeFileSync(join(paths.work, "a.txt"), "first\n");
    await layout.snapshot(task.id, 1);
    writeFileSync(join(paths.work, "b.txt"), "second\n");
    const second = await layout.snapshot(task.id, 2);

    const diff = layout.reviewDiff(task.id, second, 10_000);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("b.txt");
  });
});

describe("project setup", () => {
  it("installs dependencies once before any agent works and shares them with the review copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-layout-"));
    dirs.push(root);
    mkdirSync(join(root, "projects", "demo"), { recursive: true });
    writeFileSync(join(root, "projects", "demo", "CONTEXT.md"), "# Demo\n");
    writeFileSync(join(root, "projects", "demo", "setup.sh"), "mkdir -p node_modules/dep apps/web/node_modules\necho dep > node_modules/dep/index.js\necho web > apps/web/node_modules/w.js\necho run >> ../setup-runs\n");
    const layout = new WorkLayout(root);
    const task = { id: "t3", title: "t", request: "r", project: "demo" } as Task;

    const paths = await layout.prepare(task, []);
    await layout.prepare(task, []);
    expect(readFileSync(join(paths.root, "setup-runs"), "utf8")).toBe("run\n");

    const review = await layout.reviewCopy(task.id, 1);
    expect(readFileSync(join(review, "node_modules", "dep", "index.js"), "utf8")).toBe("dep\n");
    expect(existsSync(join(review, "apps", "web", "node_modules", "w.js"))).toBe(true);
  });
});
