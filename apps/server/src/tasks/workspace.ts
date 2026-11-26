import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Attachment, Task } from "./task-store.js";
import type { TaskEvidence } from "./schemas.js";

const run = promisify(execFile);

const GIT_IDENTITY = ["-c", "user.name=jarvis-runner", "-c", "user.email=runner@jarvis.invalid", "-c", "commit.gpgsign=false"];
const MAX_DIFF_STAT = 4000;
const SETUP_TIMEOUT_MS = 15 * 60_000;
const DEPENDENCY_DIR_DEPTH = 3;
const REVIEWED_REF = "refs/jarvis/reviewed";
/** Left in `.runner/` when a finished task's dependencies were freed, so they are installed again if it resumes. */
const TRIMMED = "dependencies-trimmed";
const REVIEW_DIFF_EXCLUDES = [
  "*.lock",
  "*.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "dist/**",
  "coverage/**",
].map((pattern) => `:(exclude,glob)**/${pattern}`);

/** Never part of a task's change: installed dependencies, build caches and local secrets. */
const LOCAL_ONLY = ["node_modules/", ".vercel/", ".next/", ".env", ".env.*", "__pycache__/", ".venv/"];

export interface ProjectInfo {
  slug: string;
  description: string;
  hasRepo: boolean;
}

export interface TaskPaths {
  root: string;
  request: string;
  context: string;
  work: string;
  runner: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...GIT_IDENTITY, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export function safeFileName(name: string): string {
  const cleaned = basename(name).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "archivo";
}

function firstLine(markdown: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 160);
}

/** Installed dependency folders of a checkout (relative paths), so a review copy can reuse them as hard links. */
function dependencyDirs(root: string, relative = "", depth = 0): string[] {
  if (depth > DEPENDENCY_DIR_DEPTH) return [];
  return readdirSync(join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".git")
    .flatMap((entry) => {
      const path = relative ? join(relative, entry.name) : entry.name;
      return entry.name === "node_modules" ? [path] : dependencyDirs(root, path, depth + 1);
    });
}

function readCapped(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[diff recortado: ${text.length} caracteres en total; leé el resto con las herramientas]` : text;
}

/**
 * Directory layout of the work volume. Each task gets its own folder; agents only ever
 * see `request/`, `context/` and `work/` of their own task, never `.runner/` or other tasks.
 */
export class WorkLayout {
  readonly tasksDir: string;
  readonly inboxDir: string;
  readonly projectsDir: string;

  constructor(readonly root: string) {
    this.tasksDir = join(root, "tasks");
    this.inboxDir = join(root, "inbox");
    this.projectsDir = join(root, "projects");
  }

  paths(taskId: string): TaskPaths {
    const root = join(this.tasksDir, taskId);
    return { root, request: join(root, "request"), context: join(root, "context"), work: join(root, "work"), runner: join(root, ".runner") };
  }

  inboxPath(attachmentId: string): string {
    return join(this.inboxDir, attachmentId);
  }

  projects(): ProjectInfo[] {
    if (!existsSync(this.projectsDir)) return [];
    return readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.projectsDir, entry.name, "CONTEXT.md")))
      .map((entry) => ({
        slug: entry.name,
        description: firstLine(readFileSync(join(this.projectsDir, entry.name, "CONTEXT.md"), "utf8")),
        hasRepo: existsSync(join(this.projectsDir, entry.name, "repo")),
      }));
  }

  hasProject(slug: string): boolean {
    return existsSync(join(this.projectsDir, slug, "CONTEXT.md"));
  }

  /**
   * Builds the task folder once: the request as written, its attachments, the project
   * context and a git repository with a baseline commit. Calling it again is a no-op.
   */
  async prepare(task: Task, attachments: readonly Attachment[]): Promise<TaskPaths> {
    const paths = this.paths(task.id);
    if (existsSync(join(paths.runner, "baseline"))) {
      await this.restoreDependencies(task, paths);
      return paths;
    }
    rmSync(paths.root, { recursive: true, force: true });
    for (const dir of [paths.request, paths.context, paths.runner]) mkdirSync(dir, { recursive: true });

    const files = attachments.map((attachment) => {
      const name = `${attachment.id.slice(0, 8)}-${safeFileName(attachment.name)}`;
      mkdirSync(join(paths.request, "files"), { recursive: true });
      cpSync(this.inboxPath(attachment.id), join(paths.request, "files", name));
      return `- files/${name} (${attachment.mediaType}, ${attachment.size} bytes)`;
    });
    writeFileSync(
      join(paths.request, "request.md"),
      [`# ${task.title}`, "", task.request, "", ...(files.length ? ["## Adjuntos", ...files] : [])].join("\n"),
    );

    const project = task.project ? join(this.projectsDir, task.project) : undefined;
    if (project && existsSync(join(project, "CONTEXT.md"))) cpSync(join(project, "CONTEXT.md"), join(paths.context, "CONTEXT.md"));
    const repo = project ? join(project, "repo") : undefined;
    if (repo && existsSync(join(repo, ".git"))) {
      await run("git", ["clone", "--quiet", "--no-hardlinks", repo, paths.work]);
    } else {
      if (repo && existsSync(repo)) cpSync(repo, paths.work, { recursive: true });
      mkdirSync(paths.work, { recursive: true });
      await git(paths.work, ["init", "--quiet", "--initial-branch=main"]);
    }
    appendFileSync(join(paths.work, ".git", "info", "exclude"), LOCAL_ONLY.join("\n") + "\n");
    await git(paths.work, ["add", "-A"]);
    await git(paths.work, ["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
    const baseline = (await git(paths.work, ["rev-parse", "HEAD"])).trim();
    if (project) await this.setUp(project, paths.work);
    writeFileSync(join(paths.runner, "baseline"), baseline);
    return paths;
  }

  /**
   * Frees the installed dependencies of a finished task, most of its size. The request, the diffs
   * and the git history stay, so its changes can still be read and published. Answers whether it freed anything.
   */
  async trimDependencies(taskId: string): Promise<boolean> {
    const paths = this.paths(taskId);
    const marker = join(paths.runner, TRIMMED);
    if (!existsSync(paths.work) || !existsSync(paths.runner) || existsSync(marker)) return false;
    for (const dir of dependencyDirs(paths.work)) await rm(join(paths.work, dir), { recursive: true, force: true });
    writeFileSync(marker, "");
    return true;
  }

  private async restoreDependencies(task: Task, paths: TaskPaths): Promise<void> {
    const marker = join(paths.runner, TRIMMED);
    if (!existsSync(marker)) return;
    if (task.project) await this.setUp(join(this.projectsDir, task.project), paths.work);
    rmSync(marker);
  }

  /**
   * Runs the project's `setup.sh` (installing dependencies) in a fresh copy, before any agent
   * touched it, so agents can build and test without network access.
   */
  private async setUp(project: string, work: string): Promise<void> {
    const script = join(project, "setup.sh");
    if (!existsSync(script)) return;
    await run("sh", [script], { cwd: work, timeout: SETUP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  }

  /** Commits whatever the executor left and measures the change against the baseline. */
  async snapshot(taskId: string, iteration: number): Promise<TaskEvidence> {
    const paths = this.paths(taskId);
    const baseline = readFileSync(join(paths.runner, "baseline"), "utf8").trim();
    const reviewed = await git(paths.work, ["rev-parse", "--verify", "--quiet", REVIEWED_REF]).then(
      (commit) => commit.trim(),
      () => baseline,
    );
    await git(paths.work, ["add", "-A"]);
    await git(paths.work, ["commit", "--quiet", "--allow-empty", "-m", `iteration ${iteration}`]);
    const changedFiles = (await git(paths.work, ["diff", "--name-only", baseline, "HEAD"])).split("\n").filter(Boolean);
    const diffStat = (await git(paths.work, ["diff", "--stat", baseline, "HEAD"])).trim().slice(0, MAX_DIFF_STAT);
    const diffPath = join(paths.runner, `iteration-${iteration}.diff`);
    writeFileSync(diffPath, await git(paths.work, ["diff", "--binary", baseline, "HEAD"]));
    const reviewDiffPath = join(paths.runner, `iteration-${iteration}.review.diff`);
    writeFileSync(reviewDiffPath, await git(paths.work, ["diff", reviewed, "HEAD", "--", ".", ...REVIEW_DIFF_EXCLUDES]));
    return { iteration, changedFiles, diffStat, diffPath, reviewDiffPath };
  }

  /** Records the current work as reviewed, so the next review diff starts from here. */
  async markReviewed(taskId: string): Promise<void> {
    await git(this.paths(taskId).work, ["update-ref", REVIEWED_REF, "HEAD"]);
  }

  /** A disposable clone of the work for the reviewer, so checks can never alter the deliverable. */
  async reviewCopy(taskId: string, iteration: number): Promise<string> {
    const paths = this.paths(taskId);
    const target = resolve(paths.root, `review-${iteration}`);
    rmSync(target, { recursive: true, force: true });
    await run("git", ["clone", "--quiet", "--no-hardlinks", paths.work, target]);
    for (const dir of dependencyDirs(paths.work)) {
      mkdirSync(dirname(join(target, dir)), { recursive: true });
      await run("cp", ["-al", join(paths.work, dir), join(target, dir)]);
    }
    return target;
  }

  /**
   * Where an evidence file lives in this process's view of the work volume. The runner and the
   * server mount it at different paths, so only the file name is taken from the stored path.
   */
  private evidenceFile(taskId: string, storedPath: string): string {
    return join(this.paths(taskId).runner, basename(storedPath));
  }

  /** The full change against the baseline, cut to `maxChars`. */
  diff(taskId: string, evidence: TaskEvidence, maxChars: number): string {
    return readCapped(this.evidenceFile(taskId, evidence.diffPath), maxChars);
  }

  /** The full change against the baseline as an applicable patch, or undefined when it is missing or too big. */
  patch(taskId: string, evidence: TaskEvidence, maxBytes: number): string | undefined {
    const path = this.evidenceFile(taskId, evidence.diffPath);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8");
    return Buffer.byteLength(text) <= maxBytes ? text : undefined;
  }

  /** What changed since the last review (or the baseline), without lockfiles or generated files, cut to `maxChars` for the reviewer's prompt. */
  reviewDiff(taskId: string, evidence: TaskEvidence, maxChars: number): string {
    return readCapped(this.evidenceFile(taskId, evidence.reviewDiffPath ?? evidence.diffPath), maxChars);
  }
}
