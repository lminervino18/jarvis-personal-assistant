import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createSdkMcpServer, query, tool, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { BUILD_CHAT_SOURCE, BUILD_PROJECT, isCommitTitle, MAX_PATCH_BYTES } from "../publisher/spool.js";
import type { ExecutionReport } from "../tasks/schemas.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { WorkLayout } from "../tasks/workspace.js";
import type { BuildChatStore, BuildTodo } from "./build-chat-store.js";
import { buildPrompt, REVIEWER_PROMPT } from "./build-prompt.js";

const exec = promisify(execFile);
const TICK_MS = 2_000;
const USAGE_WAIT_MS = 30 * 60_000;
const CRASH_RETRY_MS = 60_000;
const MAX_CRASHES = 3;
const MAX_FAILED_SHIPS = 3;
const SETUP_TIMEOUT_MS = 15 * 60_000;

export interface BuildSessionDeps {
  store: BuildChatStore;
  tasks: TaskStore;
  layout: WorkLayout;
  /** The agent's own checkout of JARVIS. */
  workspace: string;
  /** The `jarvis` project folder: `repo` is the deployed commit and `setup.sh` installs dependencies. */
  projectDir: string;
  model: string;
  reviewerModel: string;
  /** Environment for the Claude Code process: PATH, HOME, the subscription token. */
  env: Record<string, string>;
  log: { info(data: object, message?: string): void; warn(data: object, message?: string): void };
  timezone: string;
  now?: () => Date;
  queryFn?: typeof query;
  git?: (args: string[], cwd: string) => Promise<string>;
  setup?: (cwd: string) => Promise<void>;
}

const ACTIVITY: Record<string, string> = {
  Read: "Leyendo el código…",
  Glob: "Buscando en el código…",
  Grep: "Buscando en el código…",
  Edit: "Escribiendo el cambio…",
  MultiEdit: "Escribiendo el cambio…",
  Write: "Escribiendo el cambio…",
  NotebookEdit: "Escribiendo el cambio…",
  WebSearch: "Buscando en internet…",
  WebFetch: "Leyendo una página…",
  mcp__jarvis__publicar: "Mandándolo a publicar…",
};

/** What the agent is doing, in the owner's words: never a path, a command or code. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return /pnpm|vitest|tsc|eslint|npm test/.test(String(input.command ?? "")) ? "Corriendo los chequeos…" : "Probando en la terminal…";
  if (name === "Agent" || name === "Task") return input.subagent_type === "revisor" ? "El revisor está mirando el cambio…" : "Investigando con un subagente…";
  return ACTIVITY[name] ?? "Trabajando…";
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/**
 * Construir as a conversation: one long-lived Claude Code session over its own checkout of
 * JARVIS, with every permission, that answers the owner and builds what they ask. It keeps a
 * to-do list (the progress bar), asks an independent reviewer subagent before publishing, and
 * publishes through the signed publisher with its `publicar` tool. Nothing stops it but Claude's
 * own usage limit, after which it waits for the reset and goes on; a failed publication comes
 * back to it to fix. It never writes to the main chat.
 */
export class BuildSession {
  private running: Promise<void> | undefined;
  private stream: Query | undefined;
  private timer: NodeJS.Timeout | undefined;
  private crashes = 0;

  constructor(private readonly deps: BuildSessionDeps) {}

  start(): void {
    const { store } = this.deps;
    if (store.state().status === "working") {
      store.post("system", "La sesión se reinició mientras trabajabas (probablemente por un despliegue). Seguí con lo que estabas haciendo.", this.now());
      store.update({ status: "idle", activity: null }, this.now());
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.stream?.interrupt().catch(() => undefined);
    await this.running;
  }

  /** One look at the conversation: stops on request, reports publications and answers what is pending. */
  tick(): Promise<void> | undefined {
    const { store } = this.deps;
    const state = store.state();
    if (this.running) {
      if (state.stopRequested) void this.stream?.interrupt().catch(() => undefined);
      return this.running;
    }
    this.reportPublication();
    if (state.resumeAt) {
      if (Date.parse(state.resumeAt) > this.now().getTime()) return undefined;
      store.update({ resumeAt: null, status: "idle" }, this.now());
      if (state.status === "waiting") store.post("system", "Se renovó el uso del plan: seguí con lo que estabas haciendo.", this.now());
    }
    if (store.pending().length === 0) return undefined;
    this.running = this.turn().finally(() => (this.running = undefined));
    return this.running;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private git(args: string[], cwd: string): Promise<string> {
    if (this.deps.git) return this.deps.git(args, cwd);
    return exec("git", ["-c", "safe.directory=*", ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }).then((result) => result.stdout);
  }

  private async turn(): Promise<void> {
    const { store } = this.deps;
    const pending = store.pending();
    store.markHandled(pending.map((message) => message.id));
    store.update({ status: "working", activity: "Leyendo tu mensaje…", stopRequested: false }, this.now());
    const prompt = pending.map((message) => (message.role === "system" ? `[Aviso del sistema] ${message.text}` : message.text)).join("\n\n");
    let limitedUntil: number | undefined;
    try {
      const base = await this.prepareWorkspace();
      const stream = (this.deps.queryFn ?? query)({ prompt, options: this.options(base, store.state().sessionId) });
      this.stream = stream;
      for await (const message of stream) limitedUntil = this.absorb(message) ?? limitedUntil;
      this.crashes = 0;
    } catch (error) {
      this.crashed(error, pending.map((message) => message.id));
      return;
    } finally {
      this.stream = undefined;
    }
    const stopped = store.state().stopRequested;
    if (limitedUntil) {
      const at = new Date(Math.max(limitedUntil, this.now().getTime() + 60_000));
      store.update({ status: "waiting", activity: null, resumeAt: at.toISOString(), stopRequested: false }, this.now());
      store.post("assistant", `Se terminó el uso del plan de Claude. Sigo solo a las ${this.clock(at)}.`, this.now());
      return;
    }
    store.update({ status: "idle", activity: null, stopRequested: false }, this.now());
    if (stopped) store.post("assistant", "Listo, frené.", this.now());
  }

  private crashed(error: unknown, ids: number[]): void {
    const { store, log } = this.deps;
    const detail = error instanceof Error ? error.message : String(error);
    log.warn({ err: detail.slice(0, 300) }, "build session failed");
    if (/no conversation found/i.test(detail)) store.update({ sessionId: null }, this.now());
    this.crashes += 1;
    if (this.crashes > MAX_CRASHES) {
      store.update({ status: "idle", activity: null }, this.now());
      store.post("assistant", "Se me cortó la sesión varias veces seguidas y la dejé quieta. Escribime y la retomo.", this.now());
      this.crashes = 0;
      return;
    }
    const at = new Date(this.now().getTime() + CRASH_RETRY_MS);
    store.update({ status: "waiting", activity: null, resumeAt: at.toISOString() }, this.now());
    for (const id of ids) store.post("system", `La sesión anterior se cortó antes de terminar (mensaje ${id}). Seguí con lo que estabas haciendo.`, this.now());
  }

  /** Reads one message of the stream; answers the epoch ms until which the plan refuses, when it does. */
  private absorb(message: SDKMessage): number | undefined {
    const { store } = this.deps;
    if (message.type === "system" && message.subtype === "init") {
      store.update({ sessionId: message.session_id }, this.now());
      return undefined;
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;
      if (info.status === "rejected") return info.resetsAt ? info.resetsAt * 1000 : this.now().getTime() + USAGE_WAIT_MS;
      return undefined;
    }
    if (message.type !== "assistant" || message.parent_tool_use_id) return undefined;
    if (message.error === "rate_limit" || message.error === "billing_error") return this.now().getTime() + USAGE_WAIT_MS;
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) store.post("assistant", block.text.trim(), this.now());
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (block.name === "TodoWrite" && Array.isArray(input.todos)) {
        const todos = (input.todos as BuildTodo[]).map((todo) => ({ content: String(todo.content).slice(0, 200), status: todo.status, ...(todo.activeForm ? { activeForm: String(todo.activeForm).slice(0, 200) } : {}) }));
        const current = todos.find((todo) => todo.status === "in_progress");
        store.update({ todos, activity: current ? (current.activeForm ?? current.content) : null }, this.now());
      } else {
        store.update({ activity: describeTool(block.name, input) }, this.now());
      }
    }
    return undefined;
  }

  private options(base: string, sessionId: string | undefined): Options {
    const publish = tool(
      "publicar",
      "Publica en producción el cambio que hay en la carpeta: el publicador lo vuelve a chequear, lo commitea con este título, lo sube a GitHub y lo despliega. Usala solo con pnpm check en verde y el revisor conforme. Una publicación a la vez: el resultado llega después como aviso del sistema.",
      {
        commitTitle: z.string().max(100).describe("Título Conventional Commit en inglés, de una línea, por ejemplo «feat(transfers): select several files and download them as a zip»"),
        summary: z.string().max(2000).describe("Qué cambia, en castellano y sin código, para el registro"),
      },
      async (input) => text(await this.ship(input)),
    );
    return {
      cwd: this.deps.workspace,
      env: this.deps.env,
      model: this.deps.model,
      ...(sessionId ? { resume: sessionId } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: buildPrompt(base) },
      settingSources: ["project"],
      settings: { disableClaudeAiConnectors: true },
      mcpServers: { jarvis: createSdkMcpServer({ name: "jarvis", tools: [publish] }) },
      agents: {
        revisor: {
          description: "Revisor independiente: revisa el cambio completo antes de publicar y devuelve los problemas o «aprobado».",
          prompt: REVIEWER_PROMPT,
          tools: ["Read", "Glob", "Grep", "Bash"],
          model: this.deps.reviewerModel,
        },
      },
      stderr: (line) => this.deps.log.warn({ line: line.slice(0, 300) }, "build session stderr"),
    };
  }

  /** The `publicar` tool: turns the checkout's change into a reviewed-and-ready task the server publishes. */
  async ship(input: { commitTitle: string; summary: string }): Promise<string> {
    const { store, tasks, layout, workspace } = this.deps;
    const state = store.state();
    if (state.shipTaskId && state.reportedTaskId !== state.shipTaskId) return "Ya hay una publicación en curso: esperá el aviso de cómo terminó.";
    if (!isCommitTitle(input.commitTitle.trim())) return "El título tiene que ser un Conventional Commit de una línea en inglés, por ejemplo «feat(transfers): download several files as a zip».";
    if (!state.baseCommit) return "No sé contra qué commit comparar el cambio.";
    await this.git(["add", "-A"], workspace);
    const patch = await this.git(["diff", "--cached", "--binary", state.baseCommit], workspace);
    if (!patch.trim()) return "No hay cambios para publicar.";
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) return "El cambio pesa más de 2 MB: partilo en publicaciones más chicas.";
    const files = (await this.git(["diff", "--cached", "--name-only", state.baseCommit], workspace)).split("\n").filter(Boolean);
    const stat = await this.git(["diff", "--cached", "--stat", state.baseCommit], workspace);
    const now = this.now();
    const task = tasks.create({ title: input.commitTitle.trim(), request: input.summary, project: BUILD_PROJECT, source: BUILD_CHAT_SOURCE, budgetUsd: 0 }, now);
    const folder = layout.paths(task.id).runner;
    mkdirSync(folder, { recursive: true });
    const diffPath = join(folder, "publish.patch");
    writeFileSync(diffPath, patch);
    const report: ExecutionReport = { status: "done", summary: input.summary, changes: [], commandsRun: [], deliverables: [], criteria: [], questions: [], approvalsNeeded: [], commitTitle: input.commitTitle.trim() };
    tasks.update(task.id, { status: "ready", iteration: 1, report, evidence: { iteration: 1, changedFiles: files.slice(0, 200), diffStat: stat.slice(-2000), diffPath }, finishedAt: now.toISOString() }, now, ["queued"]);
    store.update({ shipTaskId: task.id }, now);
    return "Listo: lo mandé al publicador. Cuando termine te llega un aviso del sistema con el resultado.";
  }

  /** Tells the agent how its last publication ended, so it explains it to the owner or fixes it. */
  private reportPublication(): void {
    const { store, tasks } = this.deps;
    const state = store.state();
    if (!state.shipTaskId || state.reportedTaskId === state.shipTaskId) return;
    const publication = tasks.publication(state.shipTaskId);
    if (!publication || (publication.status !== "published" && publication.status !== "failed")) return;
    const now = this.now();
    if (publication.status === "published") {
      store.update({ reportedTaskId: state.shipTaskId, resetNeeded: true, failedShips: 0 }, now);
      store.post("system", `La publicación «${publication.commitTitle}» terminó bien: ya está en producción${publication.commitSha ? ` (commit ${publication.commitSha.slice(0, 7)})` : ""}.`, now);
      return;
    }
    const failed = state.failedShips + 1;
    store.update({ reportedTaskId: state.shipTaskId, failedShips: failed }, now);
    const why = `${publication.step ? `en el paso ${publication.step}` : ""}${publication.message ? `: ${publication.message}` : ""}`;
    if (failed >= MAX_FAILED_SHIPS) {
      store.update({ failedShips: 0 }, now);
      store.post("assistant", `No pude publicarlo después de ${failed} intentos (falló ${why || "sin detalle"}). Lo dejé quieto: escribime si querés que lo intente de nuevo.`, now);
      return;
    }
    store.post("system", `La publicación «${publication.commitTitle}» falló ${why || "sin detalle"}. Revisá el motivo, arreglalo y volvé a publicar.`, now);
  }

  /** The checkout the agent works in: cloned once from the deployed commit, and moved onto the new one after each publication. */
  private async prepareWorkspace(): Promise<string> {
    const { store, workspace, projectDir } = this.deps;
    const source = join(projectDir, "repo");
    const state = store.state();
    if (!existsSync(join(workspace, ".git"))) {
      mkdirSync(dirname(workspace), { recursive: true });
      await this.git(["clone", "--quiet", "--no-hardlinks", source, workspace], dirname(workspace));
      return this.settle();
    }
    if (state.resetNeeded || !state.baseCommit) {
      await this.git(["fetch", "--quiet", source, "HEAD"], workspace);
      await this.git(["reset", "--quiet", "--hard", "FETCH_HEAD"], workspace);
      await this.git(["clean", "-fdq", "-e", "node_modules"], workspace);
      return this.settle();
    }
    return state.baseCommit;
  }

  private async settle(): Promise<string> {
    const { store, workspace, projectDir } = this.deps;
    store.update({ activity: "Preparando el código…" }, this.now());
    const head = (await this.git(["rev-parse", "HEAD"], workspace)).trim();
    if (this.deps.setup) await this.deps.setup(workspace);
    else if (existsSync(join(projectDir, "setup.sh"))) await exec("sh", [join(projectDir, "setup.sh")], { cwd: workspace, env: this.deps.env, timeout: SETUP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    store.update({ baseCommit: head, resetNeeded: false }, this.now());
    return head;
  }

  private clock(date: Date): string {
    const time = date.toLocaleTimeString("es-AR", { timeZone: this.deps.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const day = date.toLocaleDateString("es-AR", { timeZone: this.deps.timezone, weekday: "long" });
    return `${time} del ${day}`;
  }
}
