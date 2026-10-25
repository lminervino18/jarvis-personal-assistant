import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMigratedDatabase, type Db } from "../db/database.js";
import { DeviceStore } from "./device-store.js";

let db: Db;
let store: DeviceStore;

beforeEach(() => {
  db = openMigratedDatabase(":memory:");
  store = new DeviceStore(db);
});

afterEach(() => db.close());

describe("DeviceStore", () => {
  it("stores only the SHA-256 of the token and never lists it", () => {
    const { device, token } = store.create("Escritorio");
    const row = db.prepare("SELECT token_hash FROM devices WHERE id = ?").get(device.id) as { token_hash: string };
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.token_hash).not.toContain(token);
    expect(JSON.stringify(store.list())).not.toContain(token);
  });

  it("issues a distinct high-entropy token per device", () => {
    const first = store.create("Uno");
    const second = store.create("Dos");
    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(43);
  });

  it("authenticates a valid token and records the visit", () => {
    const { device, token } = store.create("Escritorio");
    const seen = new Date("2026-10-25T12:00:00.000Z");
    expect(store.authenticate(token, seen)?.id).toBe(device.id);
    expect(store.list()[0]?.lastSeenAt).toBe(seen.toISOString());
  });

  it("rejects missing, unknown and revoked tokens without touching last_seen_at", () => {
    const { device, token } = store.create("Escritorio");
    expect(store.authenticate(undefined)).toBeUndefined();
    expect(store.authenticate("not-a-real-token")).toBeUndefined();
    expect(store.revoke(device.id)).toBe(true);
    expect(store.authenticate(token)).toBeUndefined();
    expect(store.isActive(device.id)).toBe(false);
    expect(store.list()[0]?.lastSeenAt).toBeNull();
  });

  it("keeps the first revocation date and reports unknown ids", () => {
    const { device } = store.create("Escritorio");
    store.revoke(device.id, new Date("2026-10-25T10:00:00.000Z"));
    store.revoke(device.id, new Date("2026-10-26T10:00:00.000Z"));
    expect(store.list()[0]?.revokedAt).toBe("2026-10-25T10:00:00.000Z");
    expect(store.revoke("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});
