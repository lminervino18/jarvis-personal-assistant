import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, type GitHubClient } from "../integrations/github/github-client.js";
import type { ServiceAccountStore } from "../integrations/service-accounts.js";
import { VercelBuildError, type VercelClient } from "../integrations/vercel/vercel-client.js";
import type { Task } from "../tasks/task-store.js";
import type { WorkLayout } from "../tasks/workspace.js";
import { git, GitError, githubRemote, type GitIdentity } from "./git.js";

export type ShipKind = "pr" | "main" | "new";

export interface ShipResult {
  commit: string;
  url: string;
  message: string;
}

/** Shipping failed at `step`; `message` is safe to show the owner (no tokens, no response bodies). */
export class ShipError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectShipperDeps {
  github: GitHubClient;
  vercel: VercelClient;
  accounts: ServiceAccountStore;
  layout: Pick<WorkLayout, "patch">;
  /** Where a repository is cloned from and pushed to; GitHub over HTTPS unless a test points it elsewhere. */
  remote?(repo: string): string;
  projectsDomain?: string;
}

const MAX_DEPLOY_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PATCH_BYTES = 25 * 1024 * 1024;

/**
 * Takes a reviewed task out of the agents' workspace: applies the exact patch the reviewer saw to a
 * clean clone, commits it as the owner and pushes it as a pull request, onto the base branch, or as a
 * new private repository that is also deployed to Vercel. Agents never touch these credentials.
 */
export class ProjectShipper {
  constructor(private readonly deps: ProjectShipperDeps) {}

  async ship(task: Task, kind: ShipKind, commitTitle: string, onStep: (step: string) => void): Promise<ShipResult> {
    const target = task.target;
    if (!target || (kind === "new") !== (target.kind === "new")) throw new ShipError("request", "Esta tarea no se publica de esa forma.");
    const token = this.deps.accounts.token("github");
    if (!token) throw new ShipError("github", "GitHub no está conectado.");
    const patch = task.evidence ? this.deps.layout.patch(task.id, task.evidence, MAX_PATCH_BYTES) : undefined;
    if (!patch?.trim()) throw new ShipError("patch", "No encontré el cambio revisado, o es demasiado grande.");
    const identity = await this.identity(token);
    const dir = mkdtempSync(join(tmpdir(), "jarvis-ship-"));
    try {
      const work = join(dir, "repo");
      const patchFile = join(dir, "change.patch");
      writeFileSync(patchFile, patch);
      if (target.kind === "github") {
        onStep("clone");
        await this.step("clone", "No pude clonar el repositorio.", () =>
          git(dir, ["clone", "--quiet", "--branch", target.base, "--single-branch", this.remote(target.repo), "repo"], { token }),
        );
        return await this.shipToRepo(task, kind as "pr" | "main", target.repo, target.base, work, patchFile, commitTitle, token, identity, onStep);
      }
      return await this.shipNew(task, target.name, dir, work, patchFile, commitTitle, token, identity, onStep);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async shipToRepo(
    task: Task,
    kind: "pr" | "main",
    repo: string,
    base: string,
    work: string,
    patchFile: string,
    commitTitle: string,
    token: string,
    identity: GitIdentity,
    onStep: (step: string) => void,
  ): Promise<ShipResult> {
    const branch = `jarvis/tarea-${task.ref}`;
    if (kind === "pr") await git(work, ["checkout", "--quiet", "-b", branch]);
    const commit = await this.commit(work, patchFile, commitTitle, identity, onStep, true);
    onStep("push");
    const ref = kind === "pr" ? branch : base;
    await this.step("push", kind === "pr" ? "GitHub rechazó la rama." : `GitHub rechazó el push a ${base}: puede que haya cambios nuevos o que la rama esté protegida.`, () =>
      git(work, ["push", "--quiet", ...(kind === "pr" ? ["--force"] : []), "origin", `HEAD:refs/heads/${ref}`], { token }),
    );
    if (kind === "main") return { commit, url: `https://github.com/${repo}/commit/${commit}`, message: `Subí la tarea #${task.ref} a ${base} de ${repo}.` };
    onStep("pull_request");
    try {
      const pull = await this.deps.github.createPull(token, repo, { title: commitTitle, body: this.pullBody(task), head: branch, base });
      return { commit, url: pull.url, message: `Abrí el PR #${pull.number} en ${repo} con la tarea #${task.ref}.` };
    } catch (error) {
      if (error instanceof GitHubError && error.reason === "conflict") {
        return { commit, url: `https://github.com/${repo}/pulls`, message: `Actualicé la rama ${branch}; el PR ya estaba abierto en ${repo}.` };
      }
      throw new ShipError("pull_request", "Subí la rama pero GitHub no me dejó abrir el PR.");
    }
  }

  private async shipNew(
    task: Task,
    name: string,
    dir: string,
    work: string,
    patchFile: string,
    commitTitle: string,
    token: string,
    identity: GitIdentity,
    onStep: (step: string) => void,
  ): Promise<ShipResult> {
    onStep("repository");
    const repo = await this.step("repository", `No pude crear el repositorio ${name}; puede que ya exista.`, () =>
      this.deps.github.createRepo(token, { name, description: task.title, private: true }),
    );
    await git(dir, ["init", "--quiet", "--initial-branch=main", "repo"]);
    const commit = await this.commit(work, patchFile, commitTitle, identity, onStep, false);
    onStep("push");
    await this.step("push", "GitHub rechazó el push al repositorio nuevo.", () => git(work, ["push", "--quiet", this.remote(repo.full_name), "HEAD:refs/heads/main"], { token }));
    const vercelToken = this.deps.accounts.token("vercel");
    if (!vercelToken) {
      return { commit, url: repo.html_url, message: `Creé el repositorio privado ${repo.full_name}. Vercel no está conectado, así que no lo publiqué en la web.` };
    }
    onStep("deploy");
    const files = (await git(work, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean)
      .map((file) => ({ file, data: readFileSync(join(work, file)) }))
      .filter(({ data }) => data.length <= MAX_DEPLOY_FILE_BYTES);
    try {
      const site = await this.deps.vercel.deploy(vercelToken, this.deps.accounts.get("vercel")?.detail ?? undefined, name, files, this.deps.projectsDomain);
      return { commit, url: site.url, message: `Publiqué la tarea #${task.ref}: repositorio privado ${repo.full_name} y sitio ${site.url}.` };
    } catch (error) {
      const inspector = error instanceof VercelBuildError && error.inspectorUrl ? ` Logs: ${error.inspectorUrl}` : "";
      throw new ShipError("deploy", `Creé ${repo.full_name}, pero Vercel no pudo publicarlo.${inspector}`);
    }
  }

  private async commit(work: string, patchFile: string, title: string, identity: GitIdentity, onStep: (step: string) => void, threeWay: boolean): Promise<string> {
    onStep("apply");
    await this.step("apply", "El cambio no aplica sobre la versión actual del repositorio.", () =>
      git(work, ["apply", "--index", "--whitespace=nowarn", ...(threeWay ? ["--3way"] : []), patchFile]),
    );
    await this.step("commit", "No había nada para commitear.", () => git(work, ["commit", "--quiet", "--no-verify", "-m", title], { identity }));
    return (await git(work, ["rev-parse", "HEAD"])).trim();
  }

  private remote(repo: string): string {
    return this.deps.remote ? this.deps.remote(repo) : githubRemote(repo);
  }

  private async identity(token: string): Promise<GitIdentity> {
    const { login, id } = await this.step("github", "GitHub no respondió.", () => this.deps.github.profile(token));
    return { name: login, email: `${id}+${login}@users.noreply.github.com` };
  }

  private pullBody(task: Task): string {
    const review = task.review ? `Revisión independiente: ${task.review.criteria.filter((c) => c.status === "pass").length} de ${task.review.criteria.length} criterios con evidencia.` : "";
    return [task.report?.summary ?? task.title, review].filter(Boolean).join("\n\n");
  }

  private async step<T>(step: string, message: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ShipError) throw error;
      const detail = error instanceof GitError ? ` (${error.message.slice(0, 200)})` : "";
      throw new ShipError(step, `${message}${detail}`);
    }
  }
}
