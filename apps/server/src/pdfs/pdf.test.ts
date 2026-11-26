import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, ToolResult } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { toolsByName } from "../tools/index.js";
import { runTool } from "../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../tools/types.js";
import { axisRange, chartSvg, formatValue, niceStep } from "./charts.js";
import { pageCount, renderPdf } from "./pdf-document.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("charts", () => {
  it("picks round axes: bars from zero, lines around their values", () => {
    expect([niceStep(59), niceStep(0.3), niceStep(1800)]).toEqual([100, 0.5, 2000]);
    expect(axisRange([142, 158, 214, 236], true)).toEqual({ min: 0, max: 400, step: 100 });
    expect(axisRange([142, 168, 220], false)).toEqual({ min: 100, max: 300, step: 50 });
    expect(axisRange([-5, 10], true)).toEqual({ min: -5, max: 15, step: 5 });
  });

  it("writes values the way people read them", () => {
    expect([formatValue(142, "US$"), formatValue(42, "%"), formatValue(1500, "km"), formatValue(2.5)]).toEqual(["US$ 142", "42%", "1.500 km", "2,5"]);
  });

  it("draws text safely and the pie with its shares", () => {
    const svg = chartSvg({ type: "chart", kind: "pie", labels: ["<script>", "Otro"], series: [{ name: "Gasto", values: [30, 10] }] });
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain(">75%<");
    expect(chartSvg({ type: "chart", kind: "line", labels: ["a", "b"], series: [{ name: "x", values: [1, 2] }, { name: "y", values: [2, 1] }] })).toContain("<polyline");
  });
});

describe("pdf_create", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-pdf-"));
    dirs.push(dir);
    const db = openMigratedDatabase(":memory:");
    const attachments = new AttachmentStore(db, dir);
    const cards: Card[] = [];
    const ctx: ToolContext = {
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], attachments, ownerName: "Loren" },
      conversationId: "c1",
      turnId: "t1",
      now: () => new Date("2026-11-26T15:00:00Z"),
      security: { tainted: true, taintSources: new Set(["WebSearch"]) },
      emitCard: (card) => cards.push(card),
      emitPlayerCommand: () => {},
    };
    const call = (input: object) => runTool(ctx, toolsByName.get("pdf_create") as AnyToolDefinition, input);
    return { attachments, cards, call };
  }

  it("leaves a real PDF in the chat, even after a web search, ready to send", async () => {
    const { attachments, cards, call } = setup();
    const result = (await call({
      title: "Vuelos baratos a Bariloche",
      blocks: [
        { type: "note", text: "La más barata: US$ 142." },
        { type: "table", columns: ["Aerolínea", "Precio"], rows: [["Flybondi", "US$ 142"]] },
        { type: "chart", kind: "bar", labels: ["Flybondi"], series: [{ name: "Precio", values: [142] }], unit: "US$" },
        { type: "link", text: "Flybondi", url: "https://flybondi.com" },
      ],
    })) as ToolResult<{ attachmentId: string; name: string; pages: number }>;
    expect(result).toMatchObject({ ok: true, items: [{ name: "Vuelos baratos a Bariloche.pdf", pages: 1 }] });
    const id = result.ok ? result.items[0]!.attachmentId : "";
    const stored = attachments.read(id);
    expect(stored?.attachment.mediaType).toBe("application/pdf");
    expect(stored?.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(cards).toEqual([expect.objectContaining({ kind: "attachment", attachmentId: id, mediaType: "application/pdf" })]);
  });

  it("refuses photos the PDF cannot carry and links that are not web pages", async () => {
    const { attachments, call } = setup();
    const gif = attachments.save({ name: "risa.gif", mediaType: "image/gif", data: Buffer.from("GIF89a") }, new Date())!;
    expect(await call({ title: "x", blocks: [{ type: "image", attachmentId: gif.id }] })).toMatchObject({ ok: false, error: { message: "«risa.gif» no es JPEG ni PNG: el PDF no puede llevarla." } });
    expect(await call({ title: "x", blocks: [{ type: "link", text: "x", url: "javascript:alert(1)" }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("breaks pages where asked and signs the end", async () => {
    const pdf = await renderPdf({ title: "Dos páginas", ownerName: "Loren", date: "26 de noviembre de 2026", images: new Map(), blocks: [{ type: "text", text: "Uno" }, { type: "pagebreak" }, { type: "text", text: "Dos" }] });
    expect(pageCount(pdf)).toBe(2);
  });
});
