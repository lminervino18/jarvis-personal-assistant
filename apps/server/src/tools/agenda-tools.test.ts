import type { Card, ToolResult, ToolSuccess } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { ContactStore } from "../agenda/contacts-store.js";
import { openMigratedDatabase } from "../db/database.js";
import { toolsByName } from "./index.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

function setup(now = new Date("2026-10-24T15:00:00Z")) {
  const db = openMigratedDatabase(":memory:");
  db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('conv-1', ?, ?)").run(now.toISOString(), now.toISOString());
  const cards: Card[] = [];
  const clock = { now };
  const ctx: ToolContext = {
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [] },
    conversationId: "conv-1",
    turnId: "turn-1",
    now: () => clock.now,
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: () => {},
  };
  const run = (name: string, input: object, turnId = ctx.turnId) =>
    runTool({ ...ctx, turnId }, toolsByName.get(name as never) as AnyToolDefinition, input);
  return { db, ctx, cards, clock, run };
}

function items<T = Record<string, unknown>>(result: ToolResult<unknown>): T[] {
  expect(result.ok).toBe(true);
  return (result as ToolSuccess<T>).items;
}

describe("contacts_resolve", () => {
  function withContacts() {
    const env = setup();
    const contacts = new ContactStore(env.db);
    const juan = contacts.create({ displayName: "Juan Pérez", aliases: ["Juancito"], identities: [{ kind: "phone", value: "+5491100000001" }] });
    const juana = contacts.create({ displayName: "Juana Díaz" });
    const joseG = contacts.create({ displayName: "José García" });
    const joseL = contacts.create({ displayName: "José López" });
    return { ...env, juan, juana, joseG, joseL };
  }

  it("matches aliases ignoring accents and case", async () => {
    const { run, juan } = withContacts();
    const result = await run("contacts_resolve", { name: "JUANCITO" });
    expect(items(result)).toEqual([{ ...juan, match: "exact" }]);
    expect(result.ok && result.note).toBeUndefined();
    expect(items(await run("contacts_resolve", { name: "jose garcia" })).map((c) => c.displayName)).toEqual(["José García"]);
  });

  it("returns every plausible person for an ambiguous nickname and tells the model to ask", async () => {
    const { run } = withContacts();
    const pepe = await run("contacts_resolve", { name: "Pepe" });
    expect(items(pepe).map((c) => [c.displayName, c.match])).toEqual([
      ["José García", "nickname"],
      ["José López", "nickname"],
    ]);
    expect(pepe.ok && pepe.note).toMatch(/Preguntá al dueño a cuál se refiere/);
    expect(items(await run("contacts_resolve", { name: "juani" })).map((c) => c.displayName)).toEqual(["Juan Pérez", "Juana Díaz"]);
  });

  it("prefers the owner's explicit alias over weaker nickname guesses", async () => {
    const { run, db, joseG } = withContacts();
    db.prepare("INSERT INTO contact_aliases (contact_id, alias, alias_normalized, source) VALUES (?, 'Pepe', 'pepe', 'owner')").run(joseG.id);
    expect(items(await run("contacts_resolve", { name: "pepe" })).map((c) => c.id)).toEqual([joseG.id]);
  });

  it("says nothing matched instead of guessing", async () => {
    const { run } = withContacts();
    const result = await run("contacts_resolve", { name: "Ramiro" });
    expect(items(result)).toEqual([]);
    expect(result.ok && result.note).toMatch(/No inventes/);
  });
});
