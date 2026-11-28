import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishRequest, sha256, verifyRequest, type PublishResult } from "./spool.js";

/** Paths a build change may never touch: they run with more privileges than the app (deploy, installer, image build) or guard publishing itself. */
/**
 * What a build change may never touch. By the owner's decision (2026-11-28) Construir changes
 * anything else, the Dockerfile and infra included; only the publisher and the deploy script stay
 * out, because the automatic rollback and every later fix depend on them.
 */
const FORBIDDEN = [/^apps\/server\/src\/publisher\//, /^infra\/scripts\/deploy\.sh$/];
const OUTPUT_TAIL_LINES = 12;
const MESSAGE_CHARS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ExecResult {
  code: number;
  output: string;
}

export type Exec = (command: string, args: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs: number }) => Promise<ExecResult>;

export interface PublisherConfig {
  dir: string;
  signingKey: string;
  fetchUrl: string;
  pushUrl: string;
  sshKey: string;
  knownHosts: string;
  authorName: string;
  authorEmail: string;
  jarvisDir: string;
  checkTimeoutMs: number;
  deployTimeoutMs: number;
}

export interface PublisherLog {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Paths touched by a git patch, read from its `diff --git` headers. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (match) {
      paths.add(match[1] as string);
      paths.add(match[2] as string);
    }
  }
  return [...paths];
}

export function forbiddenPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => path.split("/").includes("..") || FORBIDDEN.some((pattern) => pattern.test(path)));
}

function tail(output: string): string {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  return lines.slice(-OUTPUT_TAIL_LINES).join("\n").slice(-MESSAGE_CHARS);
}

const FAILURE_LINE = /(FAIL\s|×|✗|\berror\b|Error:|ENOENT|ERR_[A-Z_]+|Tests\s+\d+ failed)/i;
const MAX_FAILURE_LINES = 12;

/** The lines that say what failed (failing tests, lint and type errors), then the end of the output. */
function failureDetails(output: string): string {
  const lines = output.split("\n").map((line) => line.trimEnd().replace(/^#\d+\s+[\d.]+\s+/, "")).filter(Boolean);
  const relevant = [...new Set(lines.filter((line) => FAILURE_LINE.test(line) && !/^ERROR: failed to (build|solve)/.test(line)))].slice(0, MAX_FAILURE_LINES);
  return (relevant.length ? `${relevant.join("\n")}\n…\n${tail(output)}` : tail(output)).slice(0, MESSAGE_CHARS);
}

/**
 * Publishes owner-approved build changes, one at a time, with no model involved: it checks
 * the signature and the patch, applies it on the current main, runs the full check in the
 * image build, pushes the commit with the deploy key and deploys. A failed deploy rolls
 * back to the previous release and pushes a revert, so GitHub always matches production.
 */
export class Publisher {
  private readonly requestsDir: string;
  private readonly resultsDir: string;
  private readonly doneDir: string;
  private readonly repoDir: string;

  constructor(
    private readonly config: PublisherConfig,
    private readonly exec: Exec,
    private readonly log: PublisherLog,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.requestsDir = join(config.dir, "requests");
    this.resultsDir = join(config.dir, "results");
    this.doneDir = join(config.dir, "done");
    this.repoDir = join(config.dir, "repo");
  }

  /** Handles every waiting request, oldest first. */
  async runPending(): Promise<void> {
    const names = existsSync(this.requestsDir)
      ? readdirSync(this.requestsDir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()
      : [];
    for (const name of names) await this.handle(name);
  }

  private async handle(name: string): Promise<void> {
    const id = name.slice(0, -".json".length);
    const request = this.read(name);
    if (!request) {
      this.log.warn({ id }, "unreadable or unsigned publish request");
      if (UUID.test(id)) this.write({ id, status: "failed", step: "verify", message: "El pedido no tiene una firma válida.", at: this.now().toISOString() });
      this.archive(id);
      return;
    }
    if (!this.finished(request.id)) {
      const result = await this.publish(request);
      this.write(result);
      this.log.info({ id: request.id, status: result.status, step: result.step, commit: result.commit }, "publication finished");
    }
    this.archive(request.id);
  }

  private read(name: string): PublishRequest | undefined {
    try {
      const parsed = PublishRequest.safeParse(JSON.parse(readFileSync(join(this.requestsDir, name), "utf8")));
      if (!parsed.success || `${parsed.data.id}.json` !== name || !verifyRequest(this.config.signingKey, parsed.data)) return undefined;
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  private finished(id: string): boolean {
    const path = join(this.resultsDir, `${id}.json`);
    if (!existsSync(path)) return false;
    const status = (JSON.parse(readFileSync(path, "utf8")) as { status?: string }).status;
    return status === "published" || status === "failed";
  }

  private async publish(request: PublishRequest): Promise<PublishResult> {
    let step = "verify";
    const progress = (next: string) => {
      step = next;
      this.write({ id: request.id, status: "running", step, at: this.now().toISOString() });
    };
    try {
      const patchFile = this.verifiedPatch(request);
      progress("prepare");
      await this.prepare();
      progress("apply");
      const present = await this.alreadyPublished(patchFile);
      if (present) return { id: request.id, status: "published", step, commit: present, message: "El cambio ya estaba publicado en JARVIS.", at: this.now().toISOString() };
      await this.apply(patchFile);
      progress("checks");
      await this.check(request.id);
      const commit = await this.commit(request.commitTitle);
      progress("push");
      await this.push();
      progress("deploy");
      await this.deploy(commit, request.taskRef);
      return { id: request.id, status: "published", step, commit, at: this.now().toISOString() };
    } catch (error) {
      const failure = error instanceof StepFailure ? error : new StepFailure(step, "Error inesperado del publicador.");
      if (!(error instanceof StepFailure)) this.log.warn({ id: request.id, step, err: error instanceof Error ? error.message : "unknown" }, "publisher crashed");
      return { id: request.id, status: "failed", step: failure.step, message: failure.message.slice(0, MESSAGE_CHARS), at: this.now().toISOString() };
    }
  }

  private verifiedPatch(request: PublishRequest): string {
    const patchFile = join(this.requestsDir, `${request.id}.patch`);
    const patch = existsSync(patchFile) ? readFileSync(patchFile) : undefined;
    if (!patch || sha256(patch) !== request.patchSha256) throw new StepFailure("verify", "El cambio no coincide con el que aprobaste.");
    const blocked = forbiddenPaths(patchPaths(patch.toString("utf8")));
    if (blocked.length > 0) throw new StepFailure("verify", `El cambio toca archivos que el modo construir no puede publicar: ${blocked.slice(0, 5).join(", ")}.`);
    return patchFile;
  }

  private async prepare(): Promise<void> {
    const jarvis = this.config.jarvisDir;
    await this.must("prepare", "git", ["fetch", "--quiet", "origin"], jarvis, "No pude actualizar la copia del servidor.");
    const local = await this.run("git", ["status", "--porcelain", "--untracked-files=no"], jarvis);
    const behind = await this.run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], jarvis);
    if (local.code !== 0 || local.output.trim() || behind.code !== 0) {
      throw new StepFailure("prepare", "La copia del servidor tiene cambios que no están en GitHub; no publico nada hasta ordenarla.");
    }
    if (!existsSync(join(this.repoDir, ".git"))) {
      await this.must("prepare", "git", ["clone", "--quiet", this.config.fetchUrl, this.repoDir], this.config.dir, "No pude clonar JARVIS desde GitHub.");
    }
    await this.must("prepare", "git", ["fetch", "--quiet", "origin", "main"], this.repoDir, "No pude bajar la última versión de GitHub.");
    await this.must("prepare", "git", ["checkout", "--quiet", "--force", "-B", "publish", "origin/main"], this.repoDir, "No pude preparar la copia de publicación.");
    await this.must("prepare", "git", ["clean", "-fdxq"], this.repoDir, "No pude limpiar la copia de publicación.");
  }

  /** The current commit when the change is already in JARVIS (published by hand or by an earlier attempt). */
  private async alreadyPublished(patchFile: string): Promise<string | undefined> {
    const reverse = await this.run("git", ["apply", "--reverse", "--check", "--whitespace=nowarn", patchFile], this.repoDir);
    if (reverse.code !== 0) return undefined;
    const head = await this.run("git", ["rev-parse", "--short", "HEAD"], this.repoDir);
    return head.output.trim() || "HEAD";
  }

  private async apply(patchFile: string): Promise<void> {
    await this.must("apply", "git", ["apply", "--3way", "--whitespace=nowarn", patchFile], this.repoDir, "El cambio no aplica sobre la versión actual de JARVIS; pedilo de nuevo.");
    const staged = await this.run("git", ["diff", "--cached", "--quiet"], this.repoDir);
    if (staged.code === 0) throw new StepFailure("apply", "El cambio ya está en JARVIS o está vacío.");
  }

  private async check(id: string): Promise<void> {
    const tag = `jarvis-check:${id.slice(0, 8)}`;
    const result = await this.run("docker", ["build", "--target", "check", "--progress=plain", "--tag", tag, "."], this.repoDir, this.config.checkTimeoutMs);
    await this.run("docker", ["image", "rm", "--force", tag], this.repoDir);
    if (result.code !== 0) throw new StepFailure("checks", `No pasó lint, typecheck, tests o build:\n${failureDetails(result.output)}`);
  }

  private async commit(title: string): Promise<string> {
    const identity = ["-c", `user.name=${this.config.authorName}`, "-c", `user.email=${this.config.authorEmail}`, "-c", "commit.gpgsign=false"];
    await this.must("commit", "git", [...identity, "commit", "--quiet", "--no-verify", "-m", title], this.repoDir, "No pude crear el commit.");
    return (await this.must("commit", "git", ["rev-parse", "--short=12", "HEAD"], this.repoDir, "No pude leer el commit.")).trim();
  }

  private async push(): Promise<void> {
    await this.must("push", "git", ["push", "--quiet", this.config.pushUrl, "HEAD:refs/heads/main"], this.repoDir, "No pude subir el commit a GitHub; si main cambió, pedí publicar de nuevo.", {
      GIT_SSH_COMMAND: `ssh -i ${this.config.sshKey} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${this.config.knownHosts}`,
    });
  }

  private async deploy(commit: string, taskRef: number): Promise<void> {
    const jarvis = this.config.jarvisDir;
    await this.syncServerCopy();
    const deployed = await this.run("infra/scripts/deploy.sh", [commit], jarvis, this.config.deployTimeoutMs);
    if (deployed.code === 0) return;
    this.log.warn({ commit }, "deploy failed; rolling back");
    await this.run("infra/scripts/deploy.sh", ["rollback"], jarvis, this.config.deployTimeoutMs);
    const reverted = await this.revert(taskRef);
    throw new StepFailure(
      "deploy",
      reverted
        ? `El despliegue falló; volví a la versión anterior y revertí el commit en GitHub.\n${tail(deployed.output)}`
        : `El despliegue falló y volví a la versión anterior, pero no pude revertir el commit en GitHub: hay que revertirlo a mano.\n${tail(deployed.output)}`,
    );
  }

  private async revert(taskRef: number): Promise<boolean> {
    const identity = ["-c", `user.name=${this.config.authorName}`, "-c", `user.email=${this.config.authorEmail}`, "-c", "commit.gpgsign=false"];
    const steps: [string, string[]][] = [
      ["git", ["revert", "--no-commit", "HEAD"]],
      ["git", [...identity, "commit", "--quiet", "--no-verify", "-m", `fix(build): roll back build task ${taskRef} after a failed deploy`]],
    ];
    for (const [command, args] of steps) if ((await this.run(command, args, this.repoDir)).code !== 0) return false;
    try {
      await this.push();
      await this.syncServerCopy();
      return true;
    } catch {
      return false;
    }
  }

  private async syncServerCopy(): Promise<void> {
    const jarvis = this.config.jarvisDir;
    await this.must("deploy", "git", ["fetch", "--quiet", "origin"], jarvis, "No pude actualizar la copia del servidor.");
    await this.must("deploy", "git", ["merge", "--quiet", "--ff-only", "origin/main"], jarvis, "La copia del servidor no avanza a la versión nueva.");
  }

  private async must(step: string, command: string, args: string[], cwd: string, message: string, env?: Record<string, string>): Promise<string> {
    const result = await this.run(command, args, cwd, undefined, env);
    if (result.code !== 0) throw new StepFailure(step, message);
    return result.output;
  }

  private run(command: string, args: string[], cwd: string, timeoutMs = 5 * 60_000, env?: Record<string, string>): Promise<ExecResult> {
    return this.exec(command, args, { cwd, timeoutMs, ...(env ? { env } : {}) });
  }

  private write(result: PublishResult): void {
    mkdirSync(this.resultsDir, { recursive: true });
    const pending = join(this.resultsDir, `.${result.id}.json`);
    writeFileSync(pending, JSON.stringify(result), { mode: 0o644 });
    renameSync(pending, join(this.resultsDir, `${result.id}.json`));
  }

  private archive(id: string): void {
    mkdirSync(this.doneDir, { recursive: true });
    for (const ext of [".json", ".patch"]) {
      const from = join(this.requestsDir, `${id}${ext}`);
      if (existsSync(from)) renameSync(from, join(this.doneDir, `${id}${ext}`));
    }
  }
}
