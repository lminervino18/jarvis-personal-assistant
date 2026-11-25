import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardActions } from "../cards/actions.js";
import type { BuildTask } from "../conversation/session.js";
import { BuildScreen, buildLine } from "./BuildScreen.js";
import { appendDictation } from "./dictation.js";

const actions: CardActions = {
  decide: () => {},
  registerPlayer: () => () => {},
  reportPlayer: () => {},
  enablePush: async () => ({ ok: true }),
  taskAction: () => {},
};

const render = (over: { online?: boolean; dictation?: "idle" | "recording" | "transcribing"; tasks?: BuildTask[] } = {}) =>
  renderToStaticMarkup(
    <BuildScreen
      tasks={over.tasks ?? []}
      online={over.online ?? true}
      notice={null}
      actions={actions}
      dictation={over.dictation ?? "idle"}
      dictated={null}
      levels={() => ({ input: 0 })}
      onDictate={() => {}}
      onDictationStop={() => {}}
      onDictationCancel={() => {}}
      onRefresh={() => {}}
      onRequest={() => true}
      onReply={() => true}
      onClose={() => {}}
    />,
  );

const micTag = (html: string) => /<button[^>]*aria-label="Dictar[^"]*"[^>]*>/.exec(html)?.[0];

describe("BuildScreen dictation", () => {
  it("shows the dictate button in the composer", () => {
    expect(micTag(render())).toBeDefined();
    expect(micTag(render())).not.toContain("disabled");
  });

  it("disables the button when offline", () => {
    expect(micTag(render({ online: false }))).toContain("disabled");
  });

  it("swaps the field for the dictation bar while recording", () => {
    const html = render({ dictation: "recording" });
    expect(micTag(html)).toBeUndefined();
    expect(html).toContain("Cancelar dictado");
  });
});

const task = (over: Partial<BuildTask>): BuildTask => ({
  kind: "task",
  taskId: "3f0c6f53-9a0e-4c4e-9a43-2e0a8a5f1b10",
  ref: 4,
  title: "Agregá un modo oscuro",
  status: "running",
  phase: "execute",
  paused: false,
  iteration: 1,
  costUsd: 0,
  budgetUsd: 5,
  build: true,
  updatedAt: "2026-11-25T12:00:00.000Z",
  ...over,
});

describe("BuildScreen as a conversation", () => {
  it("shows each request and where it is, in words, without buttons", () => {
    expect(buildLine(task({}))).toBe("Programando…");
    expect(buildLine(task({ status: "accepted", publication: { status: "published", commit: "abc1234def" } }))).toBe("Listo, ya está en producción (commit abc1234).");
    const html = render({ tasks: [task({})] });
    expect(html).toContain("Agregá un modo oscuro");
    expect(html).toContain("Programando…");
    expect(html).not.toContain("build-action");
  });

  it("sends the next message as the answer when a task asked something", () => {
    const html = render({ tasks: [task({ status: "awaiting_owner", phase: "plan", blocker: { kind: "question", message: "¿Oscuro por defecto?" } })] });
    expect(html).toContain("Necesito que me respondas: ¿Oscuro por defecto?");
    expect(html).toContain("Respondé a la tarea #4");
  });
});

describe("appendDictation", () => {
  it("keeps what was already written", () => {
    expect(appendDictation("Agregá un modo", "oscuro")).toBe("Agregá un modo oscuro");
    expect(appendDictation("Hola ", "mundo")).toBe("Hola mundo");
  });
  it("uses the dictation alone when the field is empty", () => {
    expect(appendDictation("  ", "hola")).toBe("hola");
  });
});
