import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { Outbox } from "../worker/outbox.js";
import { AgendaStatusSource, PushStatusSource } from "./status.js";
import { PushSubscriptionStore } from "./subscriptions.js";

const NOW = new Date("2026-10-24T15:00:00.000Z");
const keys = { p256dh: "p256dh-fixture", auth: "auth-fixture" };
const vapid = { publicKey: "public-fixture", privateKey: "private-fixture", subject: "mailto:owner@example.test" };

describe("status sources", () => {
  const push = (config: typeof vapid | null = vapid) => {
    const db = openMigratedDatabase(":memory:");
    return { db, source: new PushStatusSource(db, config ?? undefined, () => NOW) };
  };

  it("reports push as disabled, needing a device, healthy or failing", async () => {
    expect(await push(null).source.status()).toMatchObject([{ provider: "push", status: "disabled" }]);

    const { db, source } = push();
    expect(await source.status()).toMatchObject([{ provider: "push", status: "needs_action" }]);
    new PushSubscriptionStore(db).save({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }, undefined, NOW);
    expect(await source.status()).toEqual([{ provider: "push", status: "connected", detail: "Notificaciones activas en 1 dispositivo." }]);

    db.prepare("INSERT INTO outbox (id, kind, dedupe_key, payload_json, status, next_attempt_utc, created_at) VALUES ('o1', 'push', 'k', '{}', 'dead', ?, ?)").run(
      NOW.toISOString(),
      "2026-10-23T00:00:00.000Z",
    );
    expect(await source.status()).toMatchObject([{ provider: "push", status: "error" }]);
  });

  it("reports the agenda as healthy until reminders or deliveries stall", async () => {
    const db = openMigratedDatabase(":memory:");
    const source = new AgendaStatusSource(db, "America/Argentina/Buenos_Aires", () => NOW);
    expect(await source.status()).toEqual([{ provider: "calendar", account: "Agenda interna", status: "connected", detail: "0 recordatorios programados." }]);

    const insert = db.prepare(
      "INSERT INTO reminders (id, text, due_utc, timezone, status, created_at, updated_at) VALUES (?, 'x', ?, 'America/Argentina/Buenos_Aires', 'scheduled', ?, ?)",
    );
    insert.run("r1", "2026-10-25T12:00:00.000Z", NOW.toISOString(), NOW.toISOString());
    expect(await source.status()).toMatchObject([
      { status: "connected", detail: "1 recordatorio programado. El próximo es el domingo 25 de octubre de 2026, 09:00." },
    ]);

    insert.run("r2", "2026-10-24T14:50:00.000Z", NOW.toISOString(), NOW.toISOString());
    expect(await source.status()).toMatchObject([{ provider: "calendar", status: "error" }]);

    db.prepare("DELETE FROM reminders WHERE id = 'r2'").run();
    new Outbox(db).enqueue({ kind: "push", dedupeKey: "stuck", payload: {} }, new Date("2026-10-24T14:00:00.000Z"));
    expect(await source.status()).toMatchObject([{ status: "error" }]);
  });
});
