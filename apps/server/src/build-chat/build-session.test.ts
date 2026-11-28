import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, workMigrations } from "../db/database.js";
import { TaskStore } from "../tasks/task-store.js";
import { WorkLayout } from "../tasks/workspace.js";
import { BuildChatService } from "./build-chat-service.js";
import { BuildChatStore } from "./build-chat-store.js";
import { BuildSession, describeTool } from "./build-session.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

type Script = (interrupted: () => boolean) => AsyncGenerator<SDKMessage>;

const init = (session = "s1") => ({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5-5" }) as unknown as SDKMessage;
const say = (...content: object[]) => ({ type: "assistant", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const done = () => ({ type: "result", subtype: "success", session_id: "s1" }) as unknown as SDKMessage;

function setup(scripts: Script[], diff = "diff --git a/a b/a\n") {
  const root = mkdtempSync(join(tmpdir(), "jarvis-construir-"));
  dirs.push(root);
  const db = openMigratedDatabase(":memory:", workMigrations);
  const store = new BuildChatStore(db);
  const tasks = new TaskStore(db);
  const layout = new WorkLayout(join(root, "work"));
  const workspace = join(root, "work", "build", "repo");
  let now = new Date("2026-11-28T10:00:00Z");
  const prompts: string[] = [];
  const gitCalls: string[][] = [];
  let interrupted = false;
  const queryFn = ((input: { prompt: string }) => {
    prompts.push(input.prompt);
    const script = scripts[prompts.length - 1] ?? (async function* () {})();
    const stream = (typeof script === "function" ? script(() => interrupted) : script) as AsyncGenerator<SDKMessage>;
    return Object.assign(stream, { interrupt: async () => void (interrupted = true) }) as unknown as Query;
  }) as never;
  const git = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "clone") mkdirSync(join(workspace, ".git"), { recursive: true });
    if (args[0] === "rev-parse") return "base123\n";
    if (args[0] === "diff" && args.includes("--binary")) return diff;
    if (args[0] === "diff" && args.includes("--name-only")) return "apps/web/a.ts\n";
    if (args[0] === "diff" && args.includes("--stat")) return " 1 file changed\n";
    return "";
  };
  const log = { info: () => {}, warn: () => {} };
  const session = new BuildSession({
    store,
    tasks,
    layout,
    workspace,
    projectDir: join(root, "work", "projects", "jarvis"),
    model: "claude-sonnet-5-5",
    reviewerModel: "claude-sonnet-5-5",
    env: {},
    log,
    timezone: "America/Argentina/Buenos_Aires",
    now: () => now,
    queryFn,
    git,
    setup: async () => {},
  });
  tasks.beat(now, {});
  const service = new BuildChatService(store, tasks, () => now);
  const visible = () => store.messages().map((message) => `${message.role}: ${message.text}`);
  return { store, tasks, session, service, prompts, gitCalls, visible, workspace, advance: (ms: number) => (now = new Date(now.getTime() + ms)), at: () => now };
}

describe("Construir as a conversation", () => {
  it("answers the owner, keeps its steps as the progress bar and never shows its notes", async () => {
    const env = setup([
      async function* () {
        yield init();
        yield say({ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Agregar el botón", activeForm: "Agregando el botón", status: "in_progress" }, { content: "Publicar", status: "pending" }] } });
        yield say({ type: "tool_use", name: "Bash", input: { command: "pnpm check" } });
        yield { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "nota interna del revisor" }] } } as unknown as SDKMessage;
        yield say({ type: "text", text: "Ya está el botón." });
        yield done();
      },
    ]);
    env.service.request("Agregá un botón para repetir");
    await env.session.tick();

    expect(env.visible()).toEqual(["owner: Agregá un botón para repetir", "assistant: Ya está el botón."]);
    expect(env.store.state()).toMatchObject({ sessionId: "s1", status: "idle", todos: [{ content: "Agregar el botón", status: "in_progress" }, { content: "Publicar" }] });
    expect(env.service.view().state.steps).toEqual([
      { text: "Agregando el botón", status: "in_progress" },
      { text: "Publicar", status: "pending" },
    ]);
    expect(env.gitCalls[0]?.[0]).toBe("clone");
    expect(env.store.state().baseCommit).toBe("base123");
    expect(env.store.pending()).toEqual([]);
  });

  it("describes what it does in plain words", () => {
    expect(describeTool("Bash", { command: "pnpm --filter @jarvis/server test" })).toBe("Corriendo los chequeos…");
    expect(describeTool("Agent", { subagent_type: "revisor" })).toBe("El revisor está mirando el cambio…");
    expect(describeTool("Edit", { file_path: "/secret/path.ts" })).toBe("Escribiendo el cambio…");
  });

  it("waits for the plan to reset when Claude refuses, then goes on by itself", async () => {
    const reset = Date.parse("2026-11-28T14:00:00Z") / 1000;
    const env = setup([
      async function* () {
        yield init();
        yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset } } as unknown as SDKMessage;
      },
      async function* () {
        yield init();
        yield say({ type: "text", text: "Sigo." });
      },
    ]);
    env.service.request("Hacé algo largo");
    await env.session.tick();
    expect(env.store.state()).toMatchObject({ status: "waiting", resumeAt: "2026-11-28T14:00:00.000Z" });
    expect(env.visible().at(-1)).toBe("assistant: Se terminó el uso del plan de Claude. Sigo solo a las 11:00 del sábado.");

    await env.session.tick();
    expect(env.prompts).toHaveLength(1);
    env.advance(4 * 3_600_000 + 1000);
    await env.session.tick();
    expect(env.prompts[1]).toContain("[Aviso del sistema] Se renovó el uso del plan");
    expect(env.visible().at(-1)).toBe("assistant: Sigo.");
  });

  it("publishes through a reviewed-and-ready task, one at a time, and tells the agent how it went", async () => {
    const env = setup([]);
    env.store.update({ baseCommit: "base123" }, env.at());
    expect(await env.session.ship({ commitTitle: "Agregá un botón", summary: "x" })).toContain("Conventional Commit");
    expect(await env.session.ship({ commitTitle: "feat(web): add a repeat button", summary: "Un botón para repetir la última respuesta." })).toContain("publicador");
    expect(await env.session.ship({ commitTitle: "feat(web): another", summary: "y" })).toContain("en curso");

    const taskId = env.store.state().shipTaskId!;
    const task = env.tasks.require(taskId);
    expect(task).toMatchObject({ status: "ready", project: "jarvis", source: "build-chat", report: { commitTitle: "feat(web): add a repeat button" } });
    expect(readFileSync(task.evidence!.diffPath, "utf8")).toBe("diff --git a/a b/a\n");
    expect(env.tasks.readyToPublish().map((ready) => ready.id)).toEqual([taskId]);

    const publication = env.tasks.createPublication(taskId, "feat(web): add a repeat button", env.at())!;
    expect(env.service.view().state.publication).toMatchObject({ status: "queued", title: "feat(web): add a repeat button" });
    env.tasks.updatePublication(publication.id, { status: "published", step: "deploy", commitSha: "abc1234def" }, env.at());
    mkdirSync(join(env.workspace, ".git"), { recursive: true });
    await env.session.tick();
    expect(env.prompts.at(-1)).toBe("[Aviso del sistema] La publicación «feat(web): add a repeat button» terminó bien: ya está en producción (commit abc1234).");
    expect(env.gitCalls.some((args) => args[0] === "reset")).toBe(true);
    expect(env.store.state()).toMatchObject({ resetNeeded: false, reportedTaskId: taskId });
    expect(env.service.view().state.publication).toBeUndefined();
  });

  it("sends a failed publication back to the agent, and gives up after three in a row", async () => {
    const env = setup([]);
    env.store.update({ baseCommit: "base123" }, env.at());
    const fail = async () => {
      await env.session.ship({ commitTitle: "fix(web): repair the button", summary: "z" });
      const publication = env.tasks.createPublication(env.store.state().shipTaskId!, "fix(web): repair the button", env.at())!;
      env.tasks.updatePublication(publication.id, { status: "failed", step: "checks", message: "lint falló" }, env.at());
      await env.session.tick();
    };
    await fail();
    expect(env.prompts.at(-1)).toBe("[Aviso del sistema] La publicación «fix(web): repair the button» falló en el paso checks: lint falló. Revisá el motivo, arreglalo y volvé a publicar.");
    await fail();
    await fail();
    expect(env.prompts).toHaveLength(2);
    expect(env.visible().at(-1)).toContain("No pude publicarlo después de 3 intentos");
  });

  it("refuses to publish nothing", async () => {
    const env = setup([], "");
    env.store.update({ baseCommit: "base123" }, env.at());
    expect(await env.session.ship({ commitTitle: "feat(web): nothing", summary: "-" })).toBe("No hay cambios para publicar.");
  });

  it("stops when the owner asks, and says so", async () => {
    const env = setup([
      async function* (interrupted) {
        yield init();
        while (!interrupted()) await new Promise((resolve) => setTimeout(resolve, 2));
      },
    ]);
    env.service.request("Hacé algo");
    const running = env.session.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.service.stop();
    void env.session.tick();
    await running;
    expect(env.visible().at(-1)).toBe("assistant: Listo, frené.");
    expect(env.store.state()).toMatchObject({ status: "idle", stopRequested: false });
  });

  it("picks up after a restart that cut a turn, and shows the runner as off when it stops beating", async () => {
    const env = setup([
      async function* () {
        yield init();
        yield say({ type: "text", text: "Retomo." });
      },
    ]);
    env.store.update({ status: "working", baseCommit: "base123" }, env.at());
    mkdirSync(join(env.workspace, ".git"), { recursive: true });
    env.session.start();
    await env.session.stop();
    expect(env.prompts[0]).toContain("La sesión se reinició");
    expect(existsSync(join(env.workspace, ".git"))).toBe(true);
    env.advance(5 * 60_000);
    expect(env.service.view().state.status).toBe("offline");
  });
});
