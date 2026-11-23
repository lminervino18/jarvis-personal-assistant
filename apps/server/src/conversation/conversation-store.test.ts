import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ConversationStore } from "./conversation-store.js";

describe("conversation store seed", () => {
  it("keeps the last replies whole, so a fresh session still sees the question the owner is answering", () => {
    const store = new ConversationStore(openMigratedDatabase(":memory:"));
    const { id } = store.create();
    const old = `Contexto viejo ${"bla ".repeat(300)}final viejo`;
    const reply = `Ya exploré los chats. ${"Detalle de lo que encontré. ".repeat(40)}¿Arranco por Camba 2026, BBG y SV Team?`;
    store.appendMessage({ conversationId: id, turnId: null, role: "assistant", content: old });
    for (const text of ["uno", "dos"]) store.appendMessage({ conversationId: id, turnId: null, role: "user", content: text });
    store.appendMessage({ conversationId: id, turnId: null, role: "assistant", content: reply });
    store.appendMessage({ conversationId: id, turnId: null, role: "user", content: "si" });

    const seed = store.seedContext(id, "Loren") ?? "";
    expect(seed).toContain("¿Arranco por Camba 2026, BBG y SV Team?");
    expect(seed).toContain(reply.slice(0, 60));
    const oldLine = seed.split("\n").find((line) => line.startsWith("J.A.R.V.IS: Contexto viejo")) ?? "";
    expect(oldLine.length).toBeLessThan(450);
    expect(oldLine).toContain("final viejo");
    expect(seed.split("\n").at(-1)).toBe("Loren: si");
  });
});
