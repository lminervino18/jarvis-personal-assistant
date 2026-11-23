import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardActions } from "../cards/actions.js";
import { BuildScreen } from "./BuildScreen.js";
import { appendDictation } from "./dictation.js";

const actions: CardActions = {
  decide: () => {},
  registerPlayer: () => () => {},
  reportPlayer: () => {},
  enablePush: async () => ({ ok: true }),
  taskAction: () => {},
};

const render = (over: { online?: boolean; dictation?: "idle" | "recording" | "transcribing" } = {}) =>
  renderToStaticMarkup(
    <BuildScreen
      tasks={[]}
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

describe("appendDictation", () => {
  it("keeps what was already written", () => {
    expect(appendDictation("Agregá un modo", "oscuro")).toBe("Agregá un modo oscuro");
    expect(appendDictation("Hola ", "mundo")).toBe("Hola mundo");
  });
  it("uses the dictation alone when the field is empty", () => {
    expect(appendDictation("  ", "hola")).toBe("hola");
  });
});
