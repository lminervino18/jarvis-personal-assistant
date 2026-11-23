import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, ToolResult } from "@jarvis/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { FileLinks } from "../files/file-links.js";
import type { WhatsAppFiles } from "../files/whatsapp-files.js";
import { toolsByName } from "./index.js";
import { toCallToolResult } from "./mcp-server.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(tainted = false) {
  const db = openMigratedDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-file-tools-"));
  dirs.push(dir);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', ?, ?)").run(at, at);
  const attachments = new AttachmentStore(db, dir);
  const photo = attachments.save({ name: "foto-ana.jpg", mediaType: "image/jpeg", data: Buffer.from("jpeg") }, new Date())!;
  const whatsappFiles = {
    fetch: async (chatId: string, messageId: string) =>
      chatId === "ana@s.whatsapp.net" && messageId === "M1"
        ? { ok: true as const, attachment: photo, file: { kind: "image" as const, mimetype: "image/jpeg", fileName: null, size: 4, seconds: null, voiceNote: false, attachmentId: photo.id } }
        : { ok: false as const, reason: "expired" as const },
  } as unknown as WhatsAppFiles;
  const cards: Card[] = [];
  const ctx: ToolContext = {
    services: {
      db,
      timezone: "America/Argentina/Buenos_Aires",
      backupRetentionDays: 30,
      statusSources: [],
      attachments,
      whatsappFiles,
      fileLinks: new FileLinks(db),
      filesBaseUrl: "https://p.example.test/",
      analyzeFile: async (file) => ({ images: [{ mediaType: file.mediaType, data: file.data.toString("base64") }], note: "foto" }),
    },
    conversationId: "c1",
    turnId: "t1",
    now: () => new Date("2026-11-23T12:00:00Z"),
    security: { tainted, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  const call = (name: string, input: object) => runTool(ctx, toolsByName.get(name as never) as AnyToolDefinition, input);
  return { ctx, call, cards, photo };
}

describe("file tools", () => {
  it("downloads a WhatsApp file, hands its id over and shows the photo to the model as an image", async () => {
    const { call, ctx, photo } = setup();
    const result = (await call("whatsapp_get_file", { chatId: "ana@s.whatsapp.net", messageId: "M1" })) as ToolResult<Record<string, unknown>>;
    expect(result).toMatchObject({ ok: true, items: [{ attachmentId: photo.id, name: "foto-ana.jpg", kind: "image" }] });
    expect(ctx.security.tainted).toBe(true);
    const shown = toCallToolResult("whatsapp_get_file", result);
    expect(shown.content[1]).toEqual({ type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" });
    expect(shown.content[0]?.type === "text" && shown.content[0].text).not.toContain(Buffer.from("jpeg").toString("base64"));
    expect((await call("whatsapp_get_file", { chatId: "ana@s.whatsapp.net", messageId: "OLD" })).ok).toBe(false);
  });

  it("creates a seven-day public link, behind a card when the turn read third-party content", async () => {
    const plain = setup();
    const created = (await plain.call("file_share_link", { attachmentId: plain.photo.id })) as ToolResult<{ url: string; expiresAt: string }>;
    expect(created.ok && created.items[0]?.url).toMatch(/^https:\/\/p\.example\.test\/d\/[A-Za-z0-9_-]{24}$/);
    expect(created.ok && created.items[0]?.expiresAt).toBe("2026-11-30T12:00:00.000Z");

    const tainted = setup(true);
    const pending = await tainted.call("file_share_link", { attachmentId: tainted.photo.id });
    expect(pending).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    expect(tainted.cards[0]).toMatchObject({ kind: "confirm", title: "Compartir archivo", summary: "foto-ana.jpg" });
  });
});
