import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { DiskWatch, readDiskUsage, type DiskUsage } from "./disk-watch.js";

const hour = 3_600_000;

function setup(usage: DiskUsage) {
  const db = openMigratedDatabase(":memory:");
  const current = { usage };
  const watch = new DiskWatch(db, () => current.usage);
  const entries = () => db.prepare("SELECT kind, dedupe_key AS key, payload_json AS payload FROM outbox ORDER BY created_at, kind").all() as { kind: string; key: string; payload: string }[];
  return { watch, current, entries };
}

describe("disk watch", () => {
  it("stays quiet while the disk has room", () => {
    const { watch, entries } = setup({ ratio: 0.4, freeBytes: 54 * 1024 ** 3 });
    expect(watch.check(new Date("2026-11-25T10:00:00Z"))).toBeUndefined();
    expect(entries()).toEqual([]);
  });

  it("warns by push and in the chat once a day while the disk is 80 % full or more", () => {
    const { watch, entries } = setup({ ratio: 0.83, freeBytes: 16 * 1024 ** 3 });
    const morning = new Date("2026-11-25T10:00:00Z");
    expect(watch.check(morning)?.ratio).toBe(0.83);
    watch.check(new Date(morning.getTime() + 2 * hour));
    expect(entries().map((entry) => entry.kind).sort()).toEqual(["chat_message", "push"]);
    expect(JSON.parse(entries().find((entry) => entry.kind === "push")?.payload ?? "{}").body).toBe("Disco del servidor al 83 %: quedan 16 GB.");

    watch.check(new Date("2026-11-26T10:00:00Z"));
    expect(entries()).toHaveLength(4);
  });

  it("measures the disk at most once an hour", () => {
    const { watch, current, entries } = setup({ ratio: 0.5, freeBytes: 40 * 1024 ** 3 });
    const now = new Date("2026-11-25T10:00:00Z");
    watch.check(now);
    current.usage = { ratio: 0.9, freeBytes: 9 * 1024 ** 3 };
    expect(watch.check(new Date(now.getTime() + 10 * 60_000))).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(watch.check(new Date(now.getTime() + hour))?.ratio).toBe(0.9);
  });

  it("reads real numbers from the filesystem", () => {
    const usage = readDiskUsage(".");
    expect(usage.ratio).toBeGreaterThan(0);
    expect(usage.ratio).toBeLessThanOrEqual(1);
    expect(usage.freeBytes).toBeGreaterThan(0);
  });
});
