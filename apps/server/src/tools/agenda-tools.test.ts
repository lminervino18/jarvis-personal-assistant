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

describe("calendar", () => {
  const BA = "America/Argentina/Buenos_Aires";

  it("creates an event in the owner's zone and emits an event card", async () => {
    const { run, cards } = setup();
    const [event] = items(
      await run("calendar_create", {
        title: "Dentista",
        start: "2026-10-27T13:00:00Z",
        end: "2026-10-27T11:00:00-03:00",
        location: "Consultorio",
      }),
    );
    expect(event).toMatchObject({ title: "Dentista", start: "2026-10-27T10:00:00-03:00", end: "2026-10-27T11:00:00-03:00", timezone: BA });
    expect(cards).toEqual([
      {
        kind: "event",
        eventId: event?.eventId,
        title: "Dentista",
        start: "2026-10-27T10:00:00-03:00",
        end: "2026-10-27T11:00:00-03:00",
        timezone: BA,
        location: "Consultorio",
      },
    ]);
  });

  it("expands recurring events inside the requested range and skips cancelled ones", async () => {
    const { run } = setup();
    await run("calendar_create", {
      title: "Partido",
      start: "2026-10-27T20:00:00-03:00",
      end: "2026-10-27T22:00:00-03:00",
      recurrence: "FREQ=WEEKLY;BYDAY=TU,TH",
    });
    await run("calendar_create", { title: "Cumpleaños", start: "2026-11-04T00:00:00-03:00", allDay: true });
    const [cancelled] = items(await run("calendar_create", { title: "Reunión", start: "2026-11-04T09:00:00-03:00" }));
    await run("calendar_update", { eventId: cancelled?.eventId, status: "cancelled" });

    const listed = await run("calendar_list", { from: "2026-11-02T00:00:00-03:00", to: "2026-11-08T23:59:59-03:00" });
    expect(items(listed).map((e) => [e.title, e.start, e.end])).toEqual([
      ["Partido", "2026-11-03T20:00:00-03:00", "2026-11-03T22:00:00-03:00"],
      ["Cumpleaños", "2026-11-04T00:00:00-03:00", "2026-11-05T00:00:00-03:00"],
      ["Partido", "2026-11-05T20:00:00-03:00", "2026-11-05T22:00:00-03:00"],
    ]);
    expect(listed.ok && listed.coverage?.note).toMatch(/Agenda interna/);
  });

  it("keeps the duration when only the start moves", async () => {
    const { run, cards } = setup();
    const [event] = items(await run("calendar_create", { title: "Médico", start: "2026-10-28T15:00:00-03:00", end: "2026-10-28T15:30:00-03:00" }));
    const [moved] = items(await run("calendar_update", { eventId: event?.eventId, start: "2026-10-29T17:00:00-03:00" }));
    expect(moved).toMatchObject({ start: "2026-10-29T17:00:00-03:00", end: "2026-10-29T17:30:00-03:00" });
    expect(cards.at(-1)).toMatchObject({ kind: "event", start: "2026-10-29T17:00:00-03:00" });
    expect(await run("calendar_update", { eventId: "missing", title: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects unsupported recurrences and inverted ranges", async () => {
    const { run } = setup();
    expect(await run("calendar_create", { title: "x", start: "2026-10-28T15:00:00-03:00", recurrence: "FREQ=MINUTELY" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await run("calendar_create", { title: "x", start: "2026-10-28T15:00:00-03:00", end: "2026-10-28T14:00:00-03:00" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(await run("calendar_list", { from: "2026-10-29T00:00:00-03:00", to: "2026-10-28T00:00:00-03:00" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("holds creation for confirmation with a readable summary after untrusted content", async () => {
    const { run, ctx, cards, db } = setup();
    ctx.security.tainted = true;
    const result = await run("calendar_create", { title: "Pagar deuda", start: "2026-10-27T10:00:00-03:00" });
    expect(result).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    expect(cards[0]).toMatchObject({ kind: "confirm", title: "Crear evento", details: [{ label: "Cuándo", value: "martes 27 de octubre de 2026, 10:00" }] });
    expect(db.prepare("SELECT count(*) AS n FROM calendar_events").get()).toEqual({ n: 0 });
  });
});

describe("agreements", () => {
  function withPeople() {
    const env = setup();
    const contacts = new ContactStore(env.db);
    return { ...env, nico: contacts.create({ displayName: "Nicolás Ruiz" }), sofi: contacts.create({ displayName: "Sofía Paz" }) };
  }

  it("never confirms a proposal implicitly and audits every transition", async () => {
    const { run, nico, db } = withPeople();
    const [proposal] = items(
      await run("agreements_propose", {
        title: "Jugar al pádel",
        when: "2026-10-30T20:00:00-03:00",
        counterpartContactIds: [nico.id],
        sourceType: "whatsapp",
        sourceRef: "chat-fixture-1",
      }),
    );
    expect(proposal).toMatchObject({ status: "proposed", when: "2026-10-30T20:00:00-03:00", parties: [{ contactId: nico.id, displayName: "Nicolás Ruiz" }] });
    expect(items(await run("agreements_list", { status: "confirmed" }))).toEqual([]);

    const [confirmed] = items(await run("agreements_confirm", { agreementId: proposal?.id, when: "2026-10-30T21:00:00-03:00" }));
    expect(confirmed).toMatchObject({ status: "confirmed", when: "2026-10-30T21:00:00-03:00" });
    expect(await run("agreements_confirm", { agreementId: proposal?.id }, "turn-2")).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    expect(items(await run("agreements_cancel", { agreementId: proposal?.id, reason: "llueve" }))[0]).toMatchObject({ status: "cancelled" });
    expect(await run("agreements_confirm", { agreementId: proposal?.id }, "turn-3")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const actions = db.prepare("SELECT action FROM agreement_events WHERE agreement_id = ? ORDER BY at, rowid").all(proposal?.id);
    expect(actions).toEqual([{ action: "proposed" }, { action: "confirmed" }, { action: "cancelled" }]);
  });

  it("requires owner confirmation to confirm after reading untrusted content", async () => {
    const { run, ctx } = withPeople();
    const [proposal] = items(await run("agreements_propose", { title: "Cena", sourceType: "conversation" }));
    ctx.security.tainted = true;
    expect(await run("agreements_confirm", { agreementId: proposal?.id }, "turn-2")).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    ctx.security.tainted = false;
    expect(items(await run("agreements_list", {}))[0]).toMatchObject({ status: "proposed" });
  });

  it("rejects unknown parties and filters by contact and date", async () => {
    const { run, nico, sofi } = withPeople();
    expect(await run("agreements_propose", { title: "x", counterpartContactIds: ["ghost"], sourceType: "conversation" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await run("agreements_propose", { title: "Asado", when: "2026-11-07T13:00:00-03:00", counterpartContactIds: [nico.id], sourceType: "conversation" });
    await run("agreements_propose", { title: "Cine", when: "2026-11-20T21:00:00-03:00", counterpartContactIds: [sofi.id], sourceType: "gmail" });
    expect(items(await run("agreements_list", { contactId: sofi.id })).map((a) => a.title)).toEqual(["Cine"]);
    expect(
      items(await run("agreements_list", { from: "2026-11-01T00:00:00-03:00", to: "2026-11-10T00:00:00-03:00" })).map((a) => a.title),
    ).toEqual(["Asado"]);
  });
});
