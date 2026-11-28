import { describe, expect, it } from "vitest";
import { buildGoogleHarness } from "../integrations/google/test-support.js";
import { WhatsAppStore } from "../integrations/whatsapp/message-store.js";
import { WhatsAppStatusSource } from "../integrations/whatsapp/status.js";
import { YoutubeService } from "../integrations/youtube/youtube-service.js";
import { toolsByName } from "./index.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

describe("integrations_status with the connectors", () => {
  it("lists Gmail by account, WhatsApp by source and YouTube, with work cleanly not connected", async () => {
    const { db, gmail, connect } = buildGoogleHarness();
    await connect("personal", "loren.prueba@example.test");
    const ctx: ToolContext = {
      services: {
        db,
        timezone: "America/Argentina/Buenos_Aires",
        backupRetentionDays: 30,
        statusSources: [gmail, new WhatsAppStatusSource(db, "America/Argentina/Buenos_Aires"), new YoutubeService()],
      },
      conversationId: "conv-1",
      turnId: "turn-1",
      now: () => new Date("2026-10-26T12:00:00Z"),
      security: { tainted: false, taintSources: new Set() },
      emitCard: () => {},
      emitPlayerCommand: () => {},
    };

    const result = await runTool(ctx, toolsByName.get("integrations_status") as AnyToolDefinition, {});
    expect(result.ok && result.items).toEqual([
      { provider: "gmail", account: "loren.prueba@example.test", status: "connected", detail: "Cuenta personal conectada (solo lectura)." },
      { provider: "gmail", account: "work", status: "disconnected", detail: "Cuenta de trabajo: no conectada." },
      expect.objectContaining({ provider: "whatsapp", account: "baileys", status: "disabled" }),
      expect.objectContaining({ provider: "whatsapp", account: "import", status: "disconnected" }),
      expect.objectContaining({ provider: "youtube", status: "needs_action" }),
    ]);
    expect(ctx.security.tainted).toBe(false);
  });
});

describe("integrations_status pairing card", () => {
  it("sends the pairing card only to the client, never in the tool result", async () => {
    const cards: unknown[] = [];
    const qrSource = {
      status: async () => [{ provider: "whatsapp" as const, status: "needs_action" as const, detail: "Esperando vinculación." }],
      pairingCard: () => ({ kind: "pairing" as const, provider: "whatsapp" as const, qr: "QR-SECRET-PAYLOAD", expiresAt: "2026-10-26T12:01:00Z" }),
    };
    const ctx: ToolContext = {
      services: { db: buildGoogleHarness().db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [qrSource] },
      conversationId: "conv-1",
      turnId: "turn-1",
      now: () => new Date("2026-10-26T12:00:00Z"),
      security: { tainted: false, taintSources: new Set() },
      emitCard: (card) => cards.push(card),
      emitPlayerCommand: () => {},
    };
    const result = await runTool(ctx, toolsByName.get("integrations_status") as AnyToolDefinition, {});
    expect(cards).toEqual([expect.objectContaining({ kind: "pairing", qr: "QR-SECRET-PAYLOAD" })]);
    expect(JSON.stringify(result)).not.toContain("QR-SECRET-PAYLOAD");
  });
});

describe("whatsapp_link_qr", () => {
  it("asks the bridge for a QR only when called, and waits for the owner after reading third-party content", async () => {
    const db = buildGoogleHarness().db;
    const store = new WhatsAppStore(db);
    store.setStatus("baileys", "logged_out", new Date("2026-10-26T12:00:00Z"));
    const context = (tainted: boolean): ToolContext => ({
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
      conversationId: "conv-1",
      turnId: "turn-1",
      now: () => new Date("2026-10-26T12:00:30Z"),
      security: { tainted, taintSources: new Set(tainted ? ["gmail"] : []) },
      emitCard: () => {},
      emitPlayerCommand: () => {},
    });
    await runTool(context(false), toolsByName.get("integrations_status") as AnyToolDefinition, {});
    expect(store.takeWake(new Date("2026-10-26T12:00:31Z"))).toBeUndefined();

    await runTool(context(true), toolsByName.get("whatsapp_link_qr") as AnyToolDefinition, {});
    expect(store.takeWake(new Date("2026-10-26T12:00:31Z"))).toBeUndefined();

    await runTool(context(false), toolsByName.get("whatsapp_link_qr") as AnyToolDefinition, {});
    expect(store.takeWake(new Date("2026-10-26T12:00:31Z"))).toBe("qr");
  });
});
