import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeTurnInput } from "@jarvis/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationHub } from "../conversation/hub.js";
import { ConversationOrchestrator } from "../conversation/orchestrator.js";
import { ConversationStore } from "../conversation/conversation-store.js";
import { TurnToolRegistry } from "../conversation/turn-tool-registry.js";
import { openMigratedDatabase } from "../db/database.js";
import { buildRawMail } from "../integrations/gmail/mime.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { allTools } from "../tools/index.js";
import { registerAttachmentRoutes } from "./attachment-routes.js";
import { AttachmentStore } from "./attachment-store.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const dirs: string[] = [];

function storeFixture() {
  const db = openMigratedDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-attachments-"));
  dirs.push(dir);
  return { db, attachments: new AttachmentStore(db, dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("chat attachments", () => {
  it("uploads and previews only for the owner, inline for photos and as a download for other files", async () => {
    const { attachments } = storeFixture();
    const app = Fastify();
    registerAttachmentRoutes(app, { requireOwner: (request) => request.headers["x-owner"] === "yes" }, attachments);
    const owner = { "x-owner": "yes" };
    const upload = (name: string, type: string, payload: Buffer | string, headers: Record<string, string> = owner) =>
      app.inject({ method: "POST", url: `/api/attachments?name=${encodeURIComponent(name)}`, headers: { "content-type": type, ...headers }, payload });

    expect((await upload("foto.png", "image/png", PNG, {})).statusCode).toBe(401);
    const photo = (await upload("../foto.png", "image/png", PNG)).json<{ id: string; name: string; mediaType: string; size: number }>();
    expect(photo).toMatchObject({ name: "foto.png", mediaType: "image/png", size: PNG.length });

    expect((await app.inject({ method: "GET", url: `/api/attachments/${photo.id}` })).statusCode).toBe(401);
    const preview = await app.inject({ method: "GET", url: `/api/attachments/${photo.id}`, headers: owner });
    expect(preview.headers["content-type"]).toBe("image/png");
    expect(preview.headers["content-security-policy"]).toBe("sandbox");
    expect(preview.rawPayload.equals(PNG)).toBe(true);

    const page = (await upload("nota.html", "text/html", "<script>alert(1)</script>")).json<{ id: string }>();
    const download = await app.inject({ method: "GET", url: `/api/attachments/${page.id}`, headers: owner });
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["content-disposition"]).toContain("attachment;");
    await app.close();
  });

  it("gives the model the photo and its id, and keeps it in the owner's bubble, even without text", async () => {
    const { db, attachments } = storeFixture();
    const photo = attachments.save({ name: "ticket.png", mediaType: "image/png", data: PNG }, new Date());
    const seen: RuntimeTurnInput[] = [];
    const store = new ConversationStore(db);
    const orchestrator = new ConversationOrchestrator({
      store,
      hub: new ConversationHub(),
      runtime: new ScriptedRuntime((input) => {
        seen.push(input);
        return { text: "Es un ticket de supermercado." };
      }),
      toolRegistry: new TurnToolRegistry(),
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], attachments },
      tools: allTools,
      builtinTools: [],
      ownerName: "Alex",
      sessionMaxTurns: 40,
      log: silent,
    });
    const conversationId = store.create().id;
    await orchestrator.startTurn({
      conversationId,
      turnId: crypto.randomUUID(),
      text: "",
      attachments: [photo!.id, crypto.randomUUID()],
      inputMode: "text",
      replyMode: "text",
      inputEndedAt: performance.now(),
    });
    await orchestrator.settled();

    expect(seen[0]?.files).toEqual([{ mediaType: "image/png", data: PNG.toString("base64") }]);
    expect(seen[0]?.text).toContain(`${photo!.id} «ticket.png»`);
    const owner = store.history(conversationId, 10).items.find((item) => item.role === "user");
    expect(owner?.text).toBe("");
    expect(owner?.cards).toEqual([attachments.card(photo!)]);
  });

  it("builds a multipart mail with the files attached", () => {
    const raw = Buffer.from(
      buildRawMail({ from: "dueno@example.test", to: ["a@example.test"], subject: "Fotos", body: "Te mando la foto.", files: [{ name: "cena \"1\".png", mediaType: "image/png", data: PNG }] }),
      "base64url",
    ).toString("utf8");
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(boundary).toBeDefined();
    expect(raw.split(`--${boundary}`)).toHaveLength(4);
    expect(raw).toContain("Content-Disposition: attachment;");
    expect(raw).not.toContain('cena "1"');
    expect(raw).toContain(PNG.toString("base64"));
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});
