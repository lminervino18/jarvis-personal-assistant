import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const firstDiff = layout.reviewDiff(first, 10_000);
    expect(firstDiff).toContain("a.txt");
    expect(firstDiff).not.toContain("pnpm-lock.yaml");
    const secondDiff = layout.reviewDiff(second, 10_000);
    expect(secondDiff).toContain("b.txt");
    expect(secondDiff).not.toContain("a.txt");
    expect(layout.diff(second, 10_000)).toContain("a.txt");
    expect(layout.reviewDiff(second, 20)).toContain("diff recortado");
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

    const diff = layout.reviewDiff(second, 10_000);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("b.txt");
  });
});
