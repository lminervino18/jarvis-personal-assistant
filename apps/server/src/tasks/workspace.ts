import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Attachment, Task } from "./task-store.js";
import type { TaskEvidence } from "./schemas.js";

const run = promisify(execFile);

const GIT_IDENTITY = ["-c", "user.name=jarvis-runner", "-c", "user.email=runner@jarvis.invalid", "-c", "commit.gpgsign=false"];
const MAX_DIFF_STAT = 4000;

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
    if (existsSync(join(paths.runner, "baseline"))) return paths;
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
    await git(paths.work, ["add", "-A"]);
    await git(paths.work, ["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
    const baseline = (await git(paths.work, ["rev-parse", "HEAD"])).trim();
    writeFileSync(join(paths.runner, "baseline"), baseline);
    return paths;
  }

  /** Commits whatever the executor left and measures the change against the baseline. */
  async snapshot(taskId: string, iteration: number): Promise<TaskEvidence> {
    const paths = this.paths(taskId);
    const baseline = readFileSync(join(paths.runner, "baseline"), "utf8").trim();
    await git(paths.work, ["add", "-A"]);
    await git(paths.work, ["commit", "--quiet", "--allow-empty", "-m", `iteration ${iteration}`]);
    const changedFiles = (await git(paths.work, ["diff", "--name-only", baseline, "HEAD"])).split("\n").filter(Boolean);
    const diffStat = (await git(paths.work, ["diff", "--stat", baseline, "HEAD"])).trim().slice(0, MAX_DIFF_STAT);
    const diffPath = join(paths.runner, `iteration-${iteration}.diff`);
    writeFileSync(diffPath, await git(paths.work, ["diff", baseline, "HEAD"]));
    return { iteration, changedFiles, diffStat, diffPath };
  }

  /** A disposable clone of the work for the reviewer, so checks can never alter the deliverable. */
  async reviewCopy(taskId: string, iteration: number): Promise<string> {
    const paths = this.paths(taskId);
    const target = resolve(paths.root, `review-${iteration}`);
    rmSync(target, { recursive: true, force: true });
    await run("git", ["clone", "--quiet", "--no-hardlinks", paths.work, target]);
    return target;
  }

  diff(evidence: TaskEvidence, maxChars: number): string {
    if (!existsSync(evidence.diffPath)) return "";
    const diff = readFileSync(evidence.diffPath, "utf8");
    return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n[diff recortado: ${diff.length} caracteres en total]` : diff;
  }
}
