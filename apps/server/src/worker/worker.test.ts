import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { ReminderStore } from "../agenda/reminders-store.js";
import { openDatabase, openMigratedDatabase, type Db } from "../db/database.js";
import type { PushNotification } from "../push/notification.js";
import { PushSendError, type PushSender } from "../push/sender.js";
import { PushSubscriptionStore, type StoredSubscription } from "../push/subscriptions.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { LEASE_MS, MAX_ATTEMPTS, Outbox, backoffMs } from "./outbox.js";
import { ReminderScheduler } from "./scheduler.js";

const BA = "America/Argentina/Buenos_Aires";
const NOW = new Date("2026-10-24T15:00:00.000Z");
const GRACE_MS = 360 * 60_000;
const silent = { warn: () => {}, error: () => {} };
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function fixtureDb(): { db: Db; open(): Db } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-worker-test-"));
  const path = join(dir, "jarvis.db");
  const db = openMigratedDatabase(path);
  const handles = [db];
  cleanups.push(() => {
    handles.forEach((handle) => handle.open && handle.close());
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    open() {
      const handle = openDatabase(path);
      handles.push(handle);
      return handle;
    },
  };
}

class FakeSender implements PushSender {
  readonly sent: { endpoint: string; notification: PushNotification }[] = [];
  readonly failures = new Map<string, PushSendError>();

  async send(subscription: StoredSubscription, notification: PushNotification): Promise<void> {
    const failure = this.failures.get(subscription.endpoint);
    if (failure) throw failure;
    this.sent.push({ endpoint: subscription.endpoint, notification });
  }
}

function addReminder(db: Db, input: { text: string; due: Date; rrule?: string; sensitive?: boolean; timezone?: string }) {
  return new ReminderStore(db).create(
    { text: input.text, dueUtc: input.due.toISOString(), timezone: input.timezone ?? BA, rrule: input.rrule, sensitive: input.sensitive },
    minutesFrom(NOW, -60 * 24),
  ).reminder;
}

function subscribe(db: Db, host: string): void {
  new PushSubscriptionStore(db).save({ endpoint: `https://${host}/send/abc`, keys: { p256dh: "p256dh-fixture", auth: "auth-fixture" } }, "fixture", NOW);
}

function outboxRows(db: Db) {
  return db.prepare("SELECT kind, dedupe_key, status, attempts, last_error, payload_json FROM outbox ORDER BY dedupe_key").all() as {
    kind: string;
    dedupe_key: string;
    status: string;
    attempts: number;
    last_error: string | null;
    payload_json: string;
  }[];
}

function reminderState(db: Db, id: string) {
  return db.prepare("SELECT status, due_utc, last_fired_utc FROM reminders WHERE id = ?").get(id) as { status: string; due_utc: string; last_fired_utc: string | null };
}

function systemMessages(db: Db) {
  return db.prepare("SELECT conversation_id, turn_id, role, content, cards_json FROM messages ORDER BY rid").all() as {
    conversation_id: string;
    turn_id: string | null;
    role: string;
    content: string;
    cards_json: string;
  }[];
}

const scheduler = (db: Db) => new ReminderScheduler(db, { graceMs: GRACE_MS });
const dispatcher = (db: Db, sender?: PushSender) => new OutboxDispatcher({ db, log: silent, sender });

describe("reminder scheduler", () => {
  it("fires a due one-off reminder once into push and chat outbox entries", () => {
    const db = openMigratedDatabase(":memory:");
    const reminder = addReminder(db, { text: "Llamar al médico", due: minutesFrom(NOW, -1) });
    addReminder(db, { text: "Más tarde", due: minutesFrom(NOW, 30) });

    expect(scheduler(db).tick(NOW)).toEqual({ fired: 1, late: 0, missed: 0 });
    expect(scheduler(db).tick(minutesFrom(NOW, 1))).toEqual({ fired: 0, late: 0, missed: 0 });

    expect(reminderState(db, reminder.id)).toMatchObject({ status: "fired", last_fired_utc: NOW.toISOString() });
    const key = `reminder:${reminder.id}:${reminder.dueUtc}`;
    expect(outboxRows(db).map((row) => [row.kind, row.dedupe_key, row.status])).toEqual([
      ["chat_message", `${key}:chat`, "pending"],
      ["push", `${key}:push`, "pending"],
    ]);
  });

  it("never duplicates outbox entries for the same occurrence", () => {
    const db = openMigratedDatabase(":memory:");
    const reminder = addReminder(db, { text: "Pagar", due: minutesFrom(NOW, -1) });
    scheduler(db).tick(NOW);
    db.prepare("UPDATE reminders SET status = 'scheduled' WHERE id = ?").run(reminder.id);
    scheduler(db).tick(minutesFrom(NOW, 1));
    expect(outboxRows(db)).toHaveLength(2);
  });

  it("advances a daily reminder across a DST change keeping the local time", () => {
    const db = openMigratedDatabase(":memory:");
    const reminder = addReminder(db, {
      text: "Diario",
      due: new Date("2026-10-31T13:00:00.000Z"),
      rrule: "FREQ=DAILY",
      timezone: "America/New_York",
    });
    scheduler(db).tick(new Date("2026-10-31T13:00:05.000Z"));
    expect(reminderState(db, reminder.id)).toMatchObject({ status: "scheduled", due_utc: "2026-11-01T14:00:00.000Z" });
    scheduler(db).tick(new Date("2026-11-01T14:00:05.000Z"));
    expect(reminderState(db, reminder.id).due_utc).toBe("2026-11-02T14:00:00.000Z");
  });

  it("advances weekly reminders in the owner's zone and finishes a series after its last occurrence", () => {
    const db = openMigratedDatabase(":memory:");
    const weekly = addReminder(db, { text: "Semanal", due: new Date("2026-10-24T12:00:00.000Z"), rrule: "FREQ=WEEKLY;BYDAY=SA,MO" });
    const ending = addReminder(db, { text: "Termina", due: new Date("2026-10-24T14:00:00.000Z"), rrule: "FREQ=DAILY;UNTIL=20261024T150000Z" });
    scheduler(db).tick(NOW);
    expect(reminderState(db, weekly.id)).toMatchObject({ status: "scheduled", due_utc: "2026-10-26T12:00:00.000Z" });
    expect(reminderState(db, ending.id).status).toBe("fired");
  });

  it("fires reminders overdue within the grace window as late and turns older ones into a single digest", () => {
    const db = openMigratedDatabase(":memory:");
    const recent = addReminder(db, { text: "Recién vencido", due: minutesFrom(NOW, -90) });
    const old = addReminder(db, { text: "Muy viejo", due: minutesFrom(NOW, -600) });
    const older = addReminder(db, { text: "Todavía más viejo", due: minutesFrom(NOW, -900) });
    const series = addReminder(db, { text: "Serie caída", due: minutesFrom(NOW, -1440), rrule: "FREQ=DAILY" });

    expect(scheduler(db).tick(NOW)).toEqual({ fired: 1, late: 1, missed: 3 });
    expect(reminderState(db, recent.id).status).toBe("fired");
    expect(reminderState(db, old.id)).toMatchObject({ status: "missed", last_fired_utc: null });
    expect(reminderState(db, older.id).status).toBe("missed");
    expect(reminderState(db, series.id)).toMatchObject({ status: "scheduled", last_fired_utc: null });
    expect(reminderState(db, series.id).due_utc > NOW.toISOString()).toBe(true);

    const rows = outboxRows(db);
    const digestPush = rows.find((row) => row.kind === "push" && row.dedupe_key.startsWith("missed:"));
    expect(rows.filter((row) => row.dedupe_key.startsWith("missed:"))).toHaveLength(2);
    expect(JSON.parse(digestPush?.payload_json ?? "{}")).toMatchObject({ body: "Se te pasaron 3 recordatorios mientras no estaba disponible." });
    const digestChat = rows.find((row) => row.kind === "chat_message" && row.dedupe_key.startsWith("missed:"));
    const digestText = (JSON.parse(digestChat?.payload_json ?? "{}") as { text: string }).text;
    expect(digestText).toContain("Muy viejo");
    expect(digestText).toContain("Serie caída");
    const lateChat = rows.find((row) => row.kind === "chat_message" && row.dedupe_key.startsWith(`reminder:${recent.id}`));
    expect((JSON.parse(lateChat?.payload_json ?? "{}") as { text: string }).text).toMatch(/^Recordatorio atrasado \(era para el .+\): Recién vencido$/);
    expect(scheduler(db).tick(minutesFrom(NOW, 1))).toEqual({ fired: 0, late: 0, missed: 0 });
  });

  it("respects a configured grace window", () => {
    const db = openMigratedDatabase(":memory:");
    const reminder = addReminder(db, { text: "Ventana corta", due: minutesFrom(NOW, -30) });
    expect(new ReminderScheduler(db, { graceMs: 10 * 60_000 }).tick(NOW)).toEqual({ fired: 0, late: 0, missed: 1 });
    expect(reminderState(db, reminder.id).status).toBe("missed");
  });

  it("keeps private text out of the push payload but not out of the chat", () => {
    const db = openMigratedDatabase(":memory:");
    addReminder(db, { text: "Turno con el psicólogo", due: minutesFrom(NOW, -1), sensitive: true });
    scheduler(db).tick(NOW);
    const [chat, push] = outboxRows(db);
    expect(JSON.parse(push?.payload_json ?? "{}")).toMatchObject({ title: "J.A.R.V.IS", body: "Tenés un recordatorio." });
    expect(push?.payload_json).not.toContain("psicólogo");
    expect(chat?.payload_json).toContain("psicólogo");
  });

  it("fires once when two workers share the database", () => {
    const { db, open } = fixtureDb();
    const reminder = addReminder(db, { text: "Una sola vez", due: minutesFrom(NOW, -1) });
    const other = open();
    const results = [scheduler(db).tick(NOW), scheduler(other).tick(NOW), scheduler(db).tick(NOW)];
    expect(results.map((result) => result.fired)).toEqual([1, 0, 0]);
    expect(outboxRows(db)).toHaveLength(2);
    expect(reminderState(db, reminder.id).status).toBe("fired");
  });

  it("makes a second worker wait for the claiming transaction instead of reading stale reminders", () => {
    const { db, open } = fixtureDb();
    addReminder(db, { text: "Con candado", due: minutesFrom(NOW, -1) });
    const other = open();
    other.pragma("busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    expect(() => scheduler(other).tick(NOW)).toThrow(/locked|busy/i);
    db.exec("COMMIT");
    expect(scheduler(other).tick(NOW).fired).toBe(1);
    expect(scheduler(db).tick(NOW).fired).toBe(0);
  });

  it("recovers after a crash between firing and delivery without firing again", async () => {
    const { db, open } = fixtureDb();
    const reminder = addReminder(db, { text: "Sobrevive al reinicio", due: minutesFrom(NOW, -1) });
    subscribe(db, "push.example.test");
    scheduler(db).tick(NOW);
    db.close();

    const restarted = open();
    const sender = new FakeSender();
    expect(scheduler(restarted).tick(minutesFrom(NOW, 1))).toEqual({ fired: 0, late: 0, missed: 0 });
    expect(await dispatcher(restarted, sender).runOnce(minutesFrom(NOW, 1))).toBe(2);
    expect(sender.sent.map((entry) => entry.notification.body)).toEqual(["Sobrevive al reinicio"]);
    expect(systemMessages(restarted).map((message) => message.content)).toEqual(["Recordatorio: Sobrevive al reinicio"]);
    expect(reminderState(restarted, reminder.id).status).toBe("fired");
  });

  it("fires reminders and delivers them to the chat with no model runtime available", async () => {
    const db = openMigratedDatabase(":memory:");
    addReminder(db, { text: "Sin Claude", due: minutesFrom(NOW, -1) });
    scheduler(db).tick(NOW);
    await dispatcher(db).runOnce(NOW);
    expect(systemMessages(db).map((message) => message.content)).toEqual(["Recordatorio: Sin Claude"]);
  });

  it("does not bundle the Claude runtime into the worker process", async () => {
    const result = await build({
      entryPoints: [new URL("../worker.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const sources = Object.keys(result.metafile.inputs);
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    expect(sources.filter((source) => /\/(runtime|tools|ws|voice)\//.test(source) || source.endsWith("orchestrator.ts"))).toEqual([]);
    expect(imports.filter((path) => path.startsWith("@anthropic-ai") || path.startsWith("@modelcontextprotocol"))).toEqual([]);
  });
});

describe("outbox dispatcher", () => {
  function pendingPush(db: Db, text = "Aviso") {
    new Outbox(db).enqueue(
      { kind: "push", dedupeKey: `test:${text}`, payload: { title: "J.A.R.V.IS", body: text, tag: "reminder:x", url: "/" } },
      NOW,
    );
  }

  const entry = (db: Db) => db.prepare("SELECT status, attempts, next_attempt_utc, last_error, locked_until_utc FROM outbox").get() as {
    status: string;
    attempts: number;
    next_attempt_utc: string;
    last_error: string | null;
    locked_until_utc: string | null;
  };

  it("delivers a push to every subscribed device and records the success", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "push-a.example.test");
    subscribe(db, "push-b.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    await dispatcher(db, sender).runOnce(NOW);
    expect(sender.sent.map((item) => item.endpoint).sort()).toEqual(["https://push-a.example.test/send/abc", "https://push-b.example.test/send/abc"]);
    expect(entry(db)).toMatchObject({ status: "sent", attempts: 1, locked_until_utc: null });
    expect(db.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE last_success_at IS NOT NULL").get()).toEqual({ n: 2 });
    expect(await dispatcher(db, sender).runOnce(minutesFrom(NOW, 60))).toBe(0);
  });

  it("retries with exponential backoff and buries the entry after the last attempt", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "push.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    sender.failures.set("https://push.example.test/send/abc", new PushSendError("push_http_503", 503));
    const worker = dispatcher(db, sender);

    let now = NOW;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await worker.runOnce(now)).toBe(1);
      const state = entry(db);
      expect(state.attempts).toBe(attempt);
      expect(state.last_error).toBe("push_http_503");
      if (state.status === "dead") break;
      expect(state.status).toBe("pending");
      delays.push(Date.parse(state.next_attempt_utc) - now.getTime());
      expect(await worker.runOnce(new Date(Date.parse(state.next_attempt_utc) - 1))).toBe(0);
      now = new Date(state.next_attempt_utc);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(delays).toEqual([1, 2, 3, 4, 5].map(backoffMs));
    expect(entry(db)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    expect(await worker.runOnce(minutesFrom(now, 24 * 60))).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM push_subscriptions").get()).toEqual({ n: 1 });
  });

  it("sends after a transient failure and clears the retry state", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "push.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    sender.failures.set("https://push.example.test/send/abc", new PushSendError("push_network_error"));
    const worker = dispatcher(db, sender);
    await worker.runOnce(NOW);
    sender.failures.clear();
    await worker.runOnce(minutesFrom(NOW, 1));
    expect(entry(db)).toMatchObject({ status: "sent", attempts: 2 });
    expect(sender.sent).toHaveLength(1);
  });

  it("prunes subscriptions the push service reports as gone", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "gone.example.test");
    subscribe(db, "alive.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    sender.failures.set("https://gone.example.test/send/abc", new PushSendError("push_http_410", 410));
    await dispatcher(db, sender).runOnce(NOW);
    expect(new PushSubscriptionStore(db).list().map((subscription) => subscription.endpoint)).toEqual(["https://alive.example.test/send/abc"]);
    expect(entry(db)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("prunes on 404 and closes the entry when every subscription is gone, without retrying", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "gone.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    sender.failures.set("https://gone.example.test/send/abc", new PushSendError("push_http_404", 404));
    await dispatcher(db, sender).runOnce(NOW);
    expect(new PushSubscriptionStore(db).list()).toEqual([]);
    expect(entry(db)).toMatchObject({ status: "sent", last_error: "subscriptions_gone" });
  });

  it("keeps a subscription that fails for other reasons and counts the failure", async () => {
    const db = openMigratedDatabase(":memory:");
    subscribe(db, "flaky.example.test");
    pendingPush(db);
    const sender = new FakeSender();
    sender.failures.set("https://flaky.example.test/send/abc", new PushSendError("push_http_500", 500));
    await dispatcher(db, sender).runOnce(NOW);
    expect(db.prepare("SELECT failure_count FROM push_subscriptions").get()).toEqual({ failure_count: 1 });
  });

  it("closes push entries without sending when push is disabled or nobody subscribed", async () => {
    const disabled = openMigratedDatabase(":memory:");
    subscribe(disabled, "push.example.test");
    pendingPush(disabled);
    await dispatcher(disabled).runOnce(NOW);
    expect(entry(disabled)).toMatchObject({ status: "sent", last_error: "push_disabled" });

    const empty = openMigratedDatabase(":memory:");
    pendingPush(empty);
    const sender = new FakeSender();
    await dispatcher(empty, sender).runOnce(NOW);
    expect(entry(empty)).toMatchObject({ status: "sent", last_error: "no_subscriptions" });
    expect(sender.sent).toEqual([]);
  });

  it("buries entries with an unreadable payload at once", async () => {
    const db = openMigratedDatabase(":memory:");
    new Outbox(db).enqueue({ kind: "chat_message", dedupeKey: "bad", payload: { unexpected: true } }, NOW);
    await dispatcher(db, new FakeSender()).runOnce(NOW);
    expect(entry(db)).toMatchObject({ status: "dead", last_error: "invalid_payload", attempts: 1 });
  });

  it("delivers two concurrent workers' shared entry once", async () => {
    const { db, open } = fixtureDb();
    subscribe(db, "push.example.test");
    addReminder(db, { text: "Compartido", due: minutesFrom(NOW, -1) });
    scheduler(db).tick(NOW);
    const sender = new FakeSender();
    const [first, second] = await Promise.all([dispatcher(db, sender).runOnce(NOW), dispatcher(open(), sender).runOnce(NOW)]);
    expect(first + second).toBe(2);
    expect(sender.sent).toHaveLength(1);
    expect(systemMessages(db)).toHaveLength(1);
  });

  it("leaves an entry leased by a live worker alone and reclaims it once the lease expires", async () => {
    const { db, open } = fixtureDb();
    subscribe(db, "push.example.test");
    pendingPush(db);
    expect(new Outbox(db).claim(NOW)).toMatchObject({ attempts: 1 });

    const sender = new FakeSender();
    const survivor = dispatcher(open(), sender);
    expect(await survivor.runOnce(minutesFrom(NOW, 1))).toBe(0);
    expect(await survivor.runOnce(new Date(NOW.getTime() + LEASE_MS + 1))).toBe(1);
    expect(entry(db)).toMatchObject({ status: "sent", attempts: 2 });
    expect(sender.sent).toHaveLength(1);
  });

  it("buries an entry whose holders keep crashing instead of retrying forever", async () => {
    const db = openMigratedDatabase(":memory:");
    pendingPush(db);
    const outbox = new Outbox(db);
    let now = NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(outbox.claim(now)).toMatchObject({ attempts: attempt });
      now = new Date(now.getTime() + LEASE_MS + 1);
    }
    expect(outbox.claim(now)).toBeUndefined();
    expect(entry(db)).toMatchObject({ status: "dead", last_error: "lease_expired" });
  });

  it("appends reminder messages to the most recently active conversation without a turn", async () => {
    const db = openMigratedDatabase(":memory:");
    db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('old', ?, ?), ('recent', ?, ?)").run(
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-10-24T14:00:00.000Z",
      "2026-10-24T14:00:00.000Z",
    );
    addReminder(db, { text: "Comprar pan", due: minutesFrom(NOW, -1) });
    scheduler(db).tick(NOW);
    await dispatcher(db).runOnce(NOW);
    const [message] = systemMessages(db);
    expect(message).toMatchObject({ conversation_id: "recent", turn_id: null, role: "system", content: "Recordatorio: Comprar pan" });
    expect(JSON.parse(message?.cards_json ?? "[]")).toEqual([
      { kind: "reminder", reminderId: expect.any(String), text: "Comprar pan", dueAt: "2026-10-24T11:59:00-03:00", timezone: BA, status: "fired" },
    ]);
  });

  it("starts a conversation when the owner has none yet", async () => {
    const db = openMigratedDatabase(":memory:");
    addReminder(db, { text: "Primero", due: minutesFrom(NOW, -1) });
    scheduler(db).tick(NOW);
    await dispatcher(db).runOnce(NOW);
    expect(db.prepare("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 1 });
    expect(systemMessages(db)).toHaveLength(1);
  });
});
