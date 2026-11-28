import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { toolsByName } from "./index.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

function setup() {
  const db = openMigratedDatabase(":memory:");
  const ctx: ToolContext = {
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
    conversationId: "c1",
    turnId: "t1",
    now: () => new Date("2026-11-28T12:00:00Z"),
    security: { tainted: true, taintSources: new Set(["whatsapp_get_messages"]) },
    emitCard: () => {},
    emitPlayerCommand: () => {},
  };
  const call = async (input: object) => {
    const result = await runTool(ctx, toolsByName.get("tricount" as never) as AnyToolDefinition, input);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.items[0] as { text: string; missingAliases: string[]; people: string[]; total: number };
  };
  return { call, ctx };
}

describe("tricount", () => {
  it("splits an asado with uneven shares, remembers it, and takes later expenses, payments and aliases", async () => {
    const { call } = setup();
    const first = await call({
      name: "Asado del sábado",
      people: ["Loren", "Pavón", "Gero", "Flor"],
      expenses: [
        { concept: "Carne", amount: 40_000, paidBy: "Pavón" },
        { concept: "Vino", amount: 9_000, paidBy: "Loren", participants: ["Loren", "Pavón", "Gero"] },
      ],
      aliases: { Loren: "lminervino18" },
    });
    expect(first.text).toBe("Loren → Pavón: $4.000\nGero → Pavón: $13.000\nFlor → Pavón: $10.000");
    expect(first.missingAliases).toEqual(["Pavón"]);

    const later = await call({ name: "asado del sábado", expenses: [{ concept: "Helado", amount: 3_000, paidBy: "Loren", participants: ["Gero", "Flor"], shares: { Gero: 2 } }], aliases: { Pavón: "ILOGIK" } });
    expect(later.total).toBe(52_000);
    expect(later.missingAliases).toEqual([]);
    expect(later.text).toContain("Alias Pavón: ILOGIK");

    const paid = await call({ name: "Asado del sábado", payments: [{ from: "Flor", to: "Pavón", amount: 11_000 }] });
    expect(paid.text).toBe("Loren → Pavón: $1.000\nGero → Pavón: $15.000\n\nAlias Pavón: ILOGIK");
  });

  it("works in a turn that read WhatsApp, since it only keeps the owner's own split", async () => {
    const { ctx } = setup();
    const result = await runTool(ctx, toolsByName.get("tricount" as never) as AnyToolDefinition, { name: "x", expenses: [{ concept: "Pizza", amount: 1000, paidBy: "A", participants: ["A", "B"] }] });
    expect(result).toMatchObject({ ok: true });
  });

  it("asks to start a split it does not know, and needs two people", async () => {
    const { ctx } = setup();
    const tool = toolsByName.get("tricount" as never) as AnyToolDefinition;
    expect(await runTool(ctx, tool, { name: "Viaje" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await runTool(ctx, tool, { name: "Solo", expenses: [{ concept: "Café", amount: 100, paidBy: "A", participants: ["A"] }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
