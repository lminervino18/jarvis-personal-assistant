import { renderToStaticMarkup } from "react-dom/server";
import type { BuildChatState } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import type { BuildChat } from "../conversation/session.js";
import { BuildScreen, buildProgress, buildStatusLine } from "./BuildScreen.js";
import { appendDictation } from "./dictation.js";

const idle: BuildChatState = { status: "idle", steps: [] };

const render = (over: { online?: boolean; dictation?: "idle" | "recording" | "transcribing"; chat?: BuildChat } = {}) =>
  renderToStaticMarkup(
    <BuildScreen
      chat={over.chat ?? { messages: [], state: idle }}
      online={over.online ?? true}
      notice={null}
      dictation={over.dictation ?? "idle"}
      dictated={null}
      levels={() => ({ input: 0 })}
      onDictate={() => {}}
      onDictationStop={() => {}}
      onDictationCancel={() => {}}
      onRefresh={() => {}}
      onRequest={() => true}
      onStop={() => {}}
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

describe("BuildScreen as a conversation", () => {
  it("shows the owner's messages and the agent's answers", () => {
    const html = render({
      chat: {
        messages: [
          { id: 1, role: "owner", text: "Agregá un botón", at: "2026-11-28T10:00:00Z" },
          { id: 2, role: "assistant", text: "Listo, ya está **publicado**.", at: "2026-11-28T10:05:00Z" },
        ],
        state: idle,
      },
    });
    expect(html).toContain("Agregá un botón");
    expect(html).toContain("<strong>publicado</strong>");
    expect(html).not.toContain("ver cambios");
  });

  it("shows the steps as a progress bar, what it is doing and a way to stop it", () => {
    const state: BuildChatState = {
      status: "working",
      activity: "Corriendo los chequeos…",
      steps: [
        { text: "Leer", status: "completed" },
        { text: "Corriendo los chequeos", status: "in_progress" },
        { text: "Publicar", status: "pending" },
      ],
    };
    expect(buildProgress(state)).toBeCloseTo(1 / 3);
    const html = render({ chat: { messages: [], state } });
    expect(html).toContain('aria-valuenow="33"');
    expect(html).toContain("Corriendo los chequeos…");
    expect(html).toContain("Frenar");
  });

  it("says when it publishes, waits for the plan or is not running", () => {
    expect(buildStatusLine({ status: "idle", steps: [], publication: { status: "running", step: "deploy", title: "feat: x" } })).toBe("Publicando: desplegando…");
    const now = new Date(2026, 10, 28, 10, 0);
    expect(buildStatusLine({ status: "waiting", steps: [], resumeAt: new Date(2026, 10, 28, 14, 0).toISOString() }, now)).toBe("Esperando que se renueve el plan: sigo solo a las 14:00.");
    expect(buildStatusLine({ status: "offline", steps: [] })).toContain("no está corriendo");
    expect(buildStatusLine(idle)).toBeNull();
    expect(render()).not.toContain("build-progress");
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
