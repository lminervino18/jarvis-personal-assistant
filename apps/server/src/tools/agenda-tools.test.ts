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

describe("reminders", () => {
  const BA = "America/Argentina/Buenos_Aires";

  it("creates a reminder in the owner's zone and emits a reminder card", async () => {
    const { run, cards } = setup();
    const result = await run("reminders_create", { text: "Llamar al médico", dueAt: "2026-10-25T12:00:00Z" });
    const [reminder] = items(result);
    expect(reminder).toMatchObject({ text: "Llamar al médico", dueAt: "2026-10-25T09:00:00-03:00", timezone: BA, recurrence: null, sensitive: false, status: "scheduled" });
    expect(cards).toEqual([
      { kind: "reminder", reminderId: reminder?.id, text: "Llamar al médico", dueAt: "2026-10-25T09:00:00-03:00", timezone: BA, status: "scheduled" },
    ]);
  });

  it("returns the existing reminder for the same text due within a minute and creates distinct ones otherwise", async () => {
    const { run, db } = setup();
    const [first] = items(await run("reminders_create", { text: "Tomar la pastilla", dueAt: "2026-10-25T09:00:00-03:00" }, "turn-1"));
    const duplicate = await run("reminders_create", { text: "  tomar la PASTILLA! ", dueAt: "2026-10-25T09:00:40-03:00" }, "turn-2");
    expect(items(duplicate)[0]?.id).toBe(first?.id);
    expect(duplicate.ok && duplicate.note).toMatch(/no se duplicó/);
    const later = await run("reminders_create", { text: "Tomar la pastilla", dueAt: "2026-10-25T09:02:00-03:00" }, "turn-3");
    expect(items(later)[0]?.id).not.toBe(first?.id);
    expect(db.prepare("SELECT count(*) AS n FROM reminders").get()).toEqual({ n: 2 });
  });

  it("rejects past dates and unsupported recurrences", async () => {
    const { run } = setup();
    expect(await run("reminders_create", { text: "Ayer", dueAt: "2026-10-23T09:00:00-03:00" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await run("reminders_create", { text: "x", dueAt: "2026-10-25T09:00:00-03:00", recurrence: "FREQ=HOURLY" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("anchors a recurring reminder on its first occurrence and moves a past start to the next one", async () => {
    const { run } = setup();
    const [daily] = items(await run("reminders_create", { text: "Diario", dueAt: "2026-10-26T09:00:00-03:00", recurrence: "FREQ=DAILY;COUNT=3" }));
    expect(daily).toMatchObject({ dueAt: "2026-10-26T09:00:00-03:00", recurrence: "FREQ=DAILY;UNTIL=20261028T120000Z" });
    const [weekly] = items(await run("reminders_create", { text: "Semanal", dueAt: "2026-10-19T09:00:00-03:00", recurrence: "FREQ=WEEKLY" }));
    expect(weekly).toMatchObject({ dueAt: "2026-10-26T09:00:00-03:00" });
  });

  it("modifies text, date and recurrence, and reschedules a reminder that already fired", async () => {
    const { run, db, cards } = setup();
    const [created] = items(await run("reminders_create", { text: "Pagar la luz", dueAt: "2026-10-25T09:00:00-03:00" }));
    const [renamed] = items(await run("reminders_update", { reminderId: created?.id, text: "Pagar luz y gas" }));
    expect(renamed).toMatchObject({ text: "Pagar luz y gas", dueAt: "2026-10-25T09:00:00-03:00", status: "scheduled" });
    db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ?").run(created?.id);
    const [moved] = items(await run("reminders_update", { reminderId: created?.id, dueAt: "2026-10-27T18:30:00-03:00", recurrence: "FREQ=MONTHLY" }));
    expect(moved).toMatchObject({ dueAt: "2026-10-27T18:30:00-03:00", recurrence: "FREQ=MONTHLY", status: "scheduled" });
    const [plain] = items(await run("reminders_update", { reminderId: created?.id, recurrence: null }));
    expect(plain).toMatchObject({ recurrence: null, dueAt: "2026-10-27T18:30:00-03:00" });
    expect(cards.at(-1)).toMatchObject({ kind: "reminder", reminderId: created?.id, status: "scheduled" });
    expect(await run("reminders_update", { reminderId: "missing", text: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("cancels a reminder once, keeps it out of the scheduled list and refuses to edit it", async () => {
    const { run, cards } = setup();
    const [created] = items(await run("reminders_create", { text: "Regar las plantas", dueAt: "2026-10-25T09:00:00-03:00" }));
    const [cancelled] = items(await run("reminders_cancel", { reminderId: created?.id }));
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cards.at(-1)).toMatchObject({ kind: "reminder", status: "cancelled" });
    expect(items(await run("reminders_list", {}))).toEqual([]);
    expect(items(await run("reminders_list", { status: "cancelled" })).map((r) => r.id)).toEqual([created?.id]);
    const again = await run("reminders_cancel", { reminderId: created?.id }, "turn-2");
    expect(again.ok && again.note).toMatch(/Ya estaba cancelado/);
    expect(await run("reminders_update", { reminderId: created?.id, text: "x" }, "turn-3")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await run("reminders_cancel", { reminderId: "missing" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("lists scheduled reminders by date range with pagination", async () => {
    const { run } = setup();
    for (const day of [25, 26, 27]) await run("reminders_create", { text: `Día ${day}`, dueAt: `2026-10-${day}T09:00:00-03:00` });
    const ranged = await run("reminders_list", { from: "2026-10-26T00:00:00-03:00", to: "2026-10-27T23:59:59-03:00" });
    expect(items(ranged).map((r) => r.text)).toEqual(["Día 26", "Día 27"]);
    const paged = await run("reminders_list", { limit: 2 });
    expect(items(paged).map((r) => r.text)).toEqual(["Día 25", "Día 26"]);
    expect(paged.ok && paged.page).toEqual({ hasMore: true });
  });

  it("holds creation for confirmation after untrusted content and hides nothing in the summary", async () => {
    const { run, ctx, cards, db } = setup();
    ctx.security.tainted = true;
    const result = await run("reminders_create", { text: "Transferir plata", dueAt: "2026-10-25T09:00:00-03:00", sensitive: true });
    expect(result).toMatchObject({ ok: false, error: { code: "needs_confirmation" } });
    expect(cards[0]).toMatchObject({
      kind: "confirm",
      title: "Crear recordatorio",
      details: [{ label: "Cuándo", value: "domingo 25 de octubre de 2026, 09:00" }, { label: "Privado", value: "Sí" }],
    });
    expect(db.prepare("SELECT count(*) AS n FROM reminders").get()).toEqual({ n: 0 });
  });
});
