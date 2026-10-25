import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { missedRemindersNotification, reminderNotification } from "./notification.js";
import { PushEndpointError, PushSubscriptionStore, assertPushEndpoint } from "./subscriptions.js";
import { loadVapidConfig } from "./vapid.js";

const NOW = new Date("2026-10-24T15:00:00.000Z");
const keys = { p256dh: "p256dh-fixture", auth: "auth-fixture" };

describe("vapid config", () => {
  it("is absent when nothing is set and complete when everything is", () => {
    expect(loadVapidConfig({})).toBeUndefined();
    expect(loadVapidConfig({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "  ", VAPID_SUBJECT: "" })).toBeUndefined();
    expect(loadVapidConfig({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:owner@example.test" })).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:owner@example.test",
    });
  });

  it("rejects partial settings and subjects that are not mailto or https", () => {
    expect(() => loadVapidConfig({ VAPID_PUBLIC_KEY: "pub" })).toThrow(/must be set together/);
    expect(() => loadVapidConfig({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "owner@example.test" })).toThrow(/mailto/);
  });
});

describe("push endpoint validation", () => {
  it("accepts https endpoints of public push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com:443/w/?token=abc",
    ]) {
      expect(() => assertPushEndpoint(endpoint)).not.toThrow();
    }
  });

  it("rejects insecure, private, local and credentialed endpoints", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://localhost/push",
      "https://127.0.0.1/push",
      "https://10.0.0.5/push",
      "https://192.168.1.10/push",
      "https://169.254.169.254/latest",
      "https://2130706433/push",
      "https://[::1]/push",
      "https://[fd00::1]/push",
      "https://printer.local/push",
      "https://router.lan/push",
      "https://intranet/push",
      "https://metadata.internal/push",
      "https://fcm.googleapis.com:8443/push",
      "https://owner:secret@fcm.googleapis.com/push",
      "not a url",
    ]) {
      expect(() => assertPushEndpoint(endpoint), endpoint).toThrow(PushEndpointError);
    }
  });
});

describe("push subscriptions", () => {
  it("updates an existing endpoint instead of duplicating it and resets its failures", () => {
    const db = openMigratedDatabase(":memory:");
    const store = new PushSubscriptionStore(db);
    store.save({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }, "Browser/1", NOW);
    const [first] = store.list();
    store.recordFailure(first?.id ?? "");
    store.save({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "rotated", auth: "rotated-auth" } }, "Browser/2", NOW);
    expect(store.list()).toEqual([{ id: first?.id, endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "rotated", auth: "rotated-auth" }]);
    expect(db.prepare("SELECT failure_count, user_agent FROM push_subscriptions").get()).toEqual({ failure_count: 0, user_agent: "Browser/2" });
  });

  it("refuses to store a private endpoint", () => {
    const store = new PushSubscriptionStore(openMigratedDatabase(":memory:"));
    expect(() => store.save({ endpoint: "https://10.0.0.5/push", keys }, undefined, NOW)).toThrow(PushEndpointError);
    expect(store.list()).toEqual([]);
  });
});

describe("discreet notifications", () => {
  it("shows the reminder text and tags the notification by reminder", () => {
    expect(reminderNotification({ id: "r-1", text: "Comprar pan", sensitive: false })).toEqual({
      title: "J.A.R.V.IS",
      body: "Comprar pan",
      tag: "reminder:r-1",
      url: "/",
    });
  });

  it("hides sensitive text and shortens long text", () => {
    expect(reminderNotification({ id: "r-2", text: "Resultado del análisis", sensitive: true }).body).toBe("Tenés un recordatorio.");
    const long = reminderNotification({ id: "r-3", text: "a".repeat(300), sensitive: false });
    expect(long.body).toHaveLength(140);
    expect(long.body.endsWith("…")).toBe(true);
  });

  it("summarizes missed reminders by count only", () => {
    expect(missedRemindersNotification(1).body).toBe("Se te pasó un recordatorio mientras no estaba disponible.");
    expect(missedRemindersNotification(4)).toMatchObject({ title: "J.A.R.V.IS", body: "Se te pasaron 4 recordatorios mientras no estaba disponible.", tag: "reminders:missed" });
  });
});
