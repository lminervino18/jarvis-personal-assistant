import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubClient } from "../integrations/github/github-client.js";
import type { ServiceAccountStore } from "../integrations/service-accounts.js";
import type { DeployFile, VercelClient } from "../integrations/vercel/vercel-client.js";
import type { Task } from "../tasks/task-store.js";
import { ProjectShipper } from "./project-shipper.js";
import { parseRepo, projectSlug } from "./repo-projects.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "seed", GIT_AUTHOR_EMAIL: "seed@example.test", GIT_COMMITTER_NAME: "seed", GIT_COMMITTER_EMAIL: "seed@example.test" },
  });

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "shipper-test-"));
  dirs.push(dir);
  return dir;
}

/** A bare "GitHub" repository with one commit on main, and the reviewed patch the agents made on top of it. */
function setup() {
  const root = scratch();
  const origin = join(root, "origin.git");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  run(root, "clone", "--quiet", origin, seed);
  writeFileSync(join(seed, "README.md"), "# app\n");
  run(seed, "add", "-A");
  run(seed, "commit", "--quiet", "-m", "init");
  run(seed, "push", "--quiet", "origin", "HEAD:main");
  writeFileSync(join(seed, "README.md"), "# app\n\nNueva sección.\n");
  writeFileSync(join(seed, "feature.ts"), "export const answer = 42;\n");
  run(seed, "add", "-A");
  const patch = run(seed, "diff", "--binary", "--cached");
  return { root, origin, patch };
}

function task(target: Task["target"]): Task {
  return {
    id: "8f3c2f4e-0000-4000-8000-000000000001",
    ref: 7,
    title: "Agregar la feature",
    request: "Agregá la feature",
    source: "manual",
    status: "ready",
    phase: null,
    paused: false,
    iteration: 1,
    fixRounds: 0,
    attempts: 0,
    pendingFeedback: [],
    costUsd: 0.1,
    budgetUsd: 5,
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T12:00:00.000Z",
    evidence: { diffPath: "diff.patch", changedFiles: ["README.md", "feature.ts"], diffStat: "2 files" } as Task["evidence"],
    report: { summary: "Agregué la feature con tests." } as Task["report"],
    target,
  };
}

function shipper(patch: string, remote: (repo: string) => string, options: { vercel?: boolean; deployed?: DeployFile[] } = {}) {
  const pulls: unknown[] = [];
  const github = {
    profile: async () => ({ login: "owner", id: 7 }),
    createPull: async (_token: string, repo: string, input: unknown) => {
      pulls.push({ repo, input });
      return { url: `https://github.com/${repo}/pull/1`, number: 1 };
    },
    createRepo: async (_token: string, input: { name: string }) => ({ full_name: `owner/${input.name}`, html_url: `https://github.com/owner/${input.name}` }),
  } as unknown as GitHubClient;
  const vercel = {
    deploy: async (_token: string, _team: string | undefined, name: string, files: DeployFile[], domain?: string) => {
      options.deployed?.push(...files);
      return { url: `https://${name}.${domain}` };
    },
  } as unknown as VercelClient;
  const accounts = {
    token: (provider: string) => (provider === "github" ? "token" : options.vercel ? "vercel-token" : undefined),
    get: () => ({ detail: "team_1" }),
  } as unknown as ServiceAccountStore;
  return { pulls, shipper: new ProjectShipper({ github, vercel, accounts, layout: { patch: () => patch }, projectsDomain: "example.test", remote }) };
}

/** What the agents leave in a new project: every file is new, against an empty baseline. */
function freshPatch(root: string): string {
  const work = join(root, "new-work");
  run(root, "init", "--quiet", "--initial-branch=main", work);
  writeFileSync(join(work, "index.html"), "<h1>mi-app</h1>\n");
  writeFileSync(join(work, "app.js"), "console.log('hola');\n");
  run(work, "add", "-A");
  return run(work, "diff", "--binary", "--cached");
}

const authorOf = (origin: string, ref: string) => run(origin, "log", "-1", "--format=%an <%ae>|%s|%b", ref).trim();

describe("ProjectShipper", () => {
  it("pushes the reviewed patch to a task branch as the owner and opens a pull request", async () => {
    const { origin, patch } = setup();
    const { shipper: ship, pulls } = shipper(patch, () => origin);
    const steps: string[] = [];
    const result = await ship.ship(task({ kind: "github", repo: "owner/app", base: "main" }), "pr", "feat: add the feature", (step) => steps.push(step));

    expect(result.url).toBe("https://github.com/owner/app/pull/1");
    expect(authorOf(origin, "jarvis/tarea-7")).toBe("owner <7+owner@users.noreply.github.com>|feat: add the feature|");
    expect(run(origin, "show", "jarvis/tarea-7:feature.ts")).toContain("answer = 42");
    expect(run(origin, "log", "-1", "--format=%s", "main").trim()).toBe("init");
    expect(pulls).toEqual([{ repo: "owner/app", input: expect.objectContaining({ head: "jarvis/tarea-7", base: "main", title: "feat: add the feature" }) }]);
    expect(steps).toEqual(["clone", "apply", "push", "pull_request"]);
  });

  it("pushes straight onto the base branch when the owner chose main", async () => {
    const { origin, patch } = setup();
    const result = await shipper(patch, () => origin).shipper.ship(task({ kind: "github", repo: "owner/app", base: "main" }), "main", "feat: add the feature", () => {});
    expect(result.url).toMatch(/^https:\/\/github\.com\/owner\/app\/commit\/[0-9a-f]{40}$/);
    expect(authorOf(origin, "main")).toBe("owner <7+owner@users.noreply.github.com>|feat: add the feature|");
  });

  it("creates a new repository, pushes main and deploys its files to the project's subdomain", async () => {
    const { root } = setup();
    const patch = freshPatch(root);
    const fresh = join(root, "fresh.git");
    mkdirSync(fresh);
    run(fresh, "init", "--quiet", "--bare", "--initial-branch=main");
    const deployed: DeployFile[] = [];
    const result = await shipper(patch, () => fresh, { vercel: true, deployed }).shipper.ship(task({ kind: "new", name: "mi-app" }), "new", "feat: create mi-app", () => {});

    expect(result.url).toBe("https://mi-app.example.test");
    expect(run(fresh, "ls-tree", "--name-only", "main").split("\n").filter(Boolean).sort()).toEqual(["app.js", "index.html"]);
    expect(authorOf(fresh, "main")).toBe("owner <7+owner@users.noreply.github.com>|feat: create mi-app|");
    expect(deployed.map((file) => file.file).sort()).toEqual(["app.js", "index.html"]);
  });

  it("refuses to ship a task the way it was not created for", async () => {
    const { origin, patch } = setup();
    await expect(shipper(patch, () => origin).shipper.ship(task({ kind: "github", repo: "owner/app", base: "main" }), "new", "feat: x", () => {})).rejects.toThrow(
      "no se publica de esa forma",
    );
  });
});

describe("repository names", () => {
  it("accepts owner/name and GitHub URLs, and nothing else", () => {
    expect(parseRepo("owner/app")).toBe("owner/app");
    expect(parseRepo("https://github.com/owner/app.git")).toBe("owner/app");
    expect(parseRepo("github.com/owner/app/tree/main/src")).toBe("owner/app");
    expect(parseRepo("https://gitlab.com/owner/app")).toBeUndefined();
    expect(parseRepo("owner")).toBeUndefined();
    expect(projectSlug("Owner/My.App")).toBe("gh-owner-my-app");
  });
});
