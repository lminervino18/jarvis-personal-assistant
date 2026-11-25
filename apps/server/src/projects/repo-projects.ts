import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskTarget } from "@jarvis/contracts";
import { GitHubError, type GitHubClient } from "../integrations/github/github-client.js";
import type { ServiceAccountStore } from "../integrations/service-accounts.js";
import { git, githubRemote } from "./git.js";

/** A repository or project that cannot be used, with a message for the model in Spanish. */
export class ProjectError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_connected" | "not_found" | "upstream_error",
    message: string,
  ) {
    super(message);
  }
}

const NOT_CONNECTED = "GitHub no está conectado: el dueño lo conecta desde Configuración › GitHub.";

/** `owner/name` from `owner/name`, `github.com/owner/name` or a GitHub URL with or without extra path. */
export function parseRepo(input: string): string | undefined {
  const text = input.trim().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const path = text.startsWith("github.com/") ? text.slice("github.com/".length) : text;
  const [owner, name] = path.split(/[/?#]/);
  const repo = name?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  if (!text.startsWith("github.com/") && path.split("/").length !== 2) return undefined;
  return `${owner}/${repo}`;
}

export const projectSlug = (repo: string) =>
  `gh-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.replace(/-+$/, "").slice(0, 40);

function context(repo: string, base: string): string {
  return [
    `Repositorio de GitHub ${repo} (rama ${base}).`,
    "",
    "- Trabajá sobre esta copia. No hagas push ni crees ramas: el dueño publica el resultado con un botón, como PR o en la rama base.",
    "- Seguí las convenciones del repositorio: README, CONTRIBUTING, CLAUDE.md o AGENTS.md si existen, el estilo del código y sus tests.",
    "- Instalá las dependencias con el gestor que usa el repo (por su lockfile) y corré sus tests o su build antes de terminar.",
    "- No subas secretos ni archivos `.env`.",
  ].join("\n");
}

export interface RepoProjectsDeps {
  github: GitHubClient;
  accounts: ServiceAccountStore;
  projectsDir: string;
}

/** Turns a GitHub repository into a project the agent runner can copy, and checks names for new projects. */
export class RepoProjects {
  constructor(private readonly deps: RepoProjectsDeps) {}

  /** Clones the repository (or brings an existing clone up to date) and returns its project slug and target. */
  async prepare(input: string): Promise<{ project: string; target: TaskTarget }> {
    const fullName = parseRepo(input);
    if (!fullName) throw new ProjectError("invalid_input", "No reconozco ese repositorio: pasá owner/nombre o la URL de GitHub.");
    const token = this.token();
    const repo = await this.lookup(token, fullName);
    const project = projectSlug(repo.full_name);
    const dir = join(this.deps.projectsDir, project);
    const checkout = join(dir, "repo");
    mkdirSync(dir, { recursive: true });
    try {
      if (existsSync(join(checkout, ".git"))) {
        await git(checkout, ["fetch", "--quiet", "origin", repo.default_branch], { token });
        await git(checkout, ["reset", "--quiet", "--hard", `origin/${repo.default_branch}`]);
        await git(checkout, ["clean", "--quiet", "-fdx"]);
      } else {
        await git(dir, ["clone", "--quiet", "--branch", repo.default_branch, "--single-branch", githubRemote(repo.full_name), "repo"], { token });
      }
    } catch {
      throw new ProjectError("upstream_error", `No pude clonar ${repo.full_name}; probá de nuevo en un rato.`);
    }
    writeFileSync(join(dir, "CONTEXT.md"), context(repo.full_name, repo.default_branch));
    return { project, target: { kind: "github", repo: repo.full_name, base: repo.default_branch } };
  }

  /** A new project's target, refused when the owner already has a repository with that name. */
  async newProject(name: string): Promise<TaskTarget> {
    const token = this.token();
    const { login } = await this.deps.github.profile(token);
    try {
      await this.deps.github.repo(token, `${login}/${name}`);
    } catch (error) {
      if (error instanceof GitHubError && error.reason === "not_found") return { kind: "new", name };
      throw new ProjectError("upstream_error", "GitHub no respondió; probá de nuevo en un rato.");
    }
    throw new ProjectError("invalid_input", `Ya existe el repositorio ${login}/${name}: elegí otro nombre o pasalo como repo para trabajar sobre él.`);
  }

  private token(): string {
    const token = this.deps.accounts.token("github");
    if (!token) throw new ProjectError("not_connected", NOT_CONNECTED);
    return token;
  }

  private async lookup(token: string, fullName: string) {
    try {
      return await this.deps.github.repo(token, fullName);
    } catch (error) {
      if (error instanceof GitHubError && error.reason === "not_found") throw new ProjectError("not_found", `No encontré ${fullName}, o la cuenta de GitHub conectada no tiene acceso.`);
      if (error instanceof GitHubError && error.reason === "unauthorized") throw new ProjectError("not_connected", NOT_CONNECTED);
      throw new ProjectError("upstream_error", "GitHub no respondió; probá de nuevo en un rato.");
    }
  }
}
