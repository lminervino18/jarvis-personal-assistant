import { describe, expect, it } from "vitest";
import { voiceSubtitle } from "./subtitle.js";
import { emptyThread, type ThreadMessage, type ThreadState } from "./thread.js";

function message(role: ThreadMessage["role"], text: string, cards: ThreadMessage["cards"] = []): ThreadMessage {
  return { id: `${role}-${text.length}`, turnId: null, role, text, at: "2026-11-25T12:00:00.000Z", interrupted: false, cards, streaming: false, local: false, unsent: false };
}

function thread(messages: ThreadMessage[], transcript: ThreadState["transcript"] = null): ThreadState {
  return { ...emptyThread(), messages, transcript };
}

describe("voiceSubtitle", () => {
  it("shows nothing on an empty conversation", () => {
    expect(voiceSubtitle(thread([]))).toBeNull();
  });

  it("prefers the owner's live words over the last reply", () => {
    const state = thread([message("assistant", "Listo.")], { turnId: "t", text: "recordame comprar pan", final: false });
    expect(voiceSubtitle(state)).toEqual({ speaker: "owner", text: "recordame comprar pan", cards: false });
  });

  it("shows the latest reply as plain text and says when it has cards", () => {
    const reply = message("assistant", "**Mañana** tenés:\n- reunión con [Ana](https://x.test)\n- `dentista`", [{ kind: "link", url: "https://x.test", title: "x" } as ThreadMessage["cards"][number]]);
    expect(voiceSubtitle(thread([message("user", "¿qué tengo?"), reply]))).toEqual({ speaker: "jarvis", text: "Mañana tenés: reunión con Ana dentista", cards: true });
  });

  it("skips system notices and keeps only the end of a long reply", () => {
    const long = `${"palabra ".repeat(60)}final`;
    const subtitle = voiceSubtitle(thread([message("assistant", long), message("system", "aviso")]));
    expect(subtitle?.text.startsWith("…")).toBe(true);
    expect(subtitle?.text.endsWith("final")).toBe(true);
    expect(subtitle?.text.length).toBeLessThanOrEqual(221);
  });
});
