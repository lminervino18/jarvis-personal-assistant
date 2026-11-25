import type { Card, ToolResult } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { toolsByName } from "../../tools/index.js";
import { decidePendingAction, runTool } from "../../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../../tools/types.js";
import { buildGoogleHarness, GMAIL_SCOPE } from "../google/test-support.js";
import { GMAIL_SEND_SCOPE } from "../google/oauth-client.js";
import { buildRawMail } from "./mime.js";

const OWNER = "loren.prueba@example.test";
const decoded = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

async function setup(scope = `openid email ${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`, tainted = false) {
  const harness = buildGoogleHarness();
  await harness.connect("personal", OWNER, { scope });
  harness.fake.calls.length = 0;
  const at = new Date().toISOString();
  harness.db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', ?, ?)").run(at, at);
  const cards: Card[] = [];
  const ctx: ToolContext = {
    services: { db: harness.db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], gmail: harness.gmail },
    conversationId: "c1",
    turnId: "t1",
    now: () => new Date(),
    security: { tainted, taintSources: new Set<string>() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  const send = (input: object) => runTool(ctx, toolsByName.get("gmail_send") as AnyToolDefinition, input);
  const confirm = (result: ToolResult<unknown>) => decidePendingAction(ctx, toolsByName, (result as { error: { actionId: string } }).error.actionId, "confirm");
  const sent = () => harness.fake.calls.filter((call) => call.url.endsWith("/messages/send"));
  return { ...harness, ctx, cards, send, confirm, sent };
}

describe("outgoing mail", () => {
  it("builds a UTF-8 message Gmail accepts, without header injection", () => {
    const raw = decoded(buildRawMail({ from: OWNER, to: ["ventas@empresa.example"], subject: "Consulta por envíos", body: "Hola,\nquería consultar.\n\nLoren" }));
    expect(raw).toContain("To: ventas@empresa.example");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Consulta por envíos").toString("base64")}?=`);
    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hola,\r\nquería consultar.\r\n\r\nLoren");
    expect(() => buildRawMail({ from: OWNER, to: ["a@b.example"], subject: "hola\r\nBcc: espia@x.example", body: "x" })).toThrow();
  });

  it("sends a clear request right away, from the owner's account", async () => {
    const { send, sent, cards } = await setup();
    const result = await send({ to: ["ventas@empresa.example"], subject: "Consulta", body: "Hola, ¿hacen envíos?" });
    expect(result).toMatchObject({ ok: true });
    expect(cards).toEqual([]);
    expect(sent()).toHaveLength(1);
  });

  it("waits for the owner's OK after the turn read third-party content, then sends exactly that mail", async () => {
    const { send, confirm, sent, cards } = await setup(undefined, true);
    const result = await send({ to: ["ventas@empresa.example"], subject: "Consulta", body: "Hola, ¿hacen envíos?" });
    expect(result).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    expect(cards[0]).toMatchObject({ kind: "confirm", title: "Enviar mail", summary: "Para ventas@empresa.example" });
    expect(sent()).toEqual([]);

    expect((await confirm(result)).status).toBe("executed");
    expect(sent()).toHaveLength(1);
    const raw = decoded((JSON.parse(sent()[0]!.body) as { raw: string }).raw);
    expect(raw).toContain(`From: ${OWNER}`);
    expect(raw).toContain("To: ventas@empresa.example");
  });

  it("asks to reconnect when the account was connected without permission to send", async () => {
    const { send, cards, sent } = await setup(`openid email ${GMAIL_SCOPE}`);
    const result = await send({ to: ["ventas@empresa.example"], subject: "Consulta", body: "Hola" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_connected", message: expect.stringContaining("sin permiso para enviar") } });
    expect(cards).toMatchObject([{ kind: "integration", provider: "gmail", actionUrl: "/api/integrations/google/start?label=personal" }]);
    expect(sent()).toEqual([]);
  });

  it("replaces the pending mail to the same people when the owner corrects it", async () => {
    const { send, db } = await setup(undefined, true);
    await send({ to: ["ventas@empresa.example"], subject: "Consulta", body: "Hola" });
    await send({ to: ["VENTAS@empresa.example"], subject: "Consulta", body: "Buenas tardes" });
    await send({ to: ["otra@empresa.example"], subject: "Otra", body: "Hola" });
    expect(db.prepare("SELECT status FROM pending_actions ORDER BY created_at, rowid").all()).toEqual([{ status: "rejected" }, { status: "pending" }, { status: "pending" }]);
  });
});
