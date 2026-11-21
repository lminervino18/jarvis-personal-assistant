import type { Card } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { toolsByName } from "./index.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

const tool = (name: string) => toolsByName.get(name as never) as AnyToolDefinition;

function setup() {
  const cards: Card[] = [];
  const ctx: ToolContext = {
    services: { db: openMigratedDatabase(":memory:"), timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
    conversationId: "conv-1",
    turnId: "turn-1",
    now: () => new Date("2026-11-21T15:00:00Z"),
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  return { ctx, cards };
}

describe("display tools", () => {
  it("shows a chart card when every series has one value per label", async () => {
    const { ctx, cards } = setup();
    const result = await runTool(ctx, tool("show_chart"), {
      title: "Avance de tareas",
      chart: "progress",
      labels: ["#1", "#2"],
      series: [{ name: "Avance", values: [100, 40] }],
      unit: "%",
    });
    expect(result.ok).toBe(true);
    expect(cards).toEqual([{ kind: "chart", title: "Avance de tareas", chart: "progress", labels: ["#1", "#2"], series: [{ name: "Avance", values: [100, 40] }], unit: "%" }]);
  });

  it("refuses series that do not match the labels and pies with several series", async () => {
    const { ctx, cards } = setup();
    const short = await runTool(ctx, tool("show_chart"), { title: "Gastos", chart: "bar", labels: ["a", "b"], series: [{ name: "x", values: [1] }] });
    expect(short).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const pie = await runTool(ctx, tool("show_chart"), {
      title: "Reparto",
      chart: "pie",
      labels: ["a"],
      series: [
        { name: "x", values: [1] },
        { name: "y", values: [2] },
      ],
    });
    expect(pie).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(cards).toHaveLength(0);
  });

  it("shows a table and refuses rows wider than the columns", async () => {
    const { ctx, cards } = setup();
    const table = await runTool(ctx, tool("show_table"), { title: "Tareas", columns: ["#", "Estado"], rows: [["1", "Lista"]] });
    expect(table.ok).toBe(true);
    expect(cards[0]).toMatchObject({ kind: "table", rows: [["1", "Lista"]] });
    const wide = await runTool(ctx, tool("show_table"), { title: "Tareas", columns: ["#"], rows: [["1", "extra"]] });
    expect(wide).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
