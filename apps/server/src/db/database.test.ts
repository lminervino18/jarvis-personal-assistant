import { describe, expect, it } from "vitest";
import { migrate, openMigratedDatabase } from "./database.js";

describe("database", () => {
  it("applies migrations once and keeps FTS in sync", () => {
    const db = openMigratedDatabase(":memory:");
    expect(migrate(db)).toEqual([]);

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, category, status, source_type, created_at, updated_at) VALUES (?, ?, 'preference', 'active', 'owner_statement', ?, ?)",
    ).run("m1", "Prefiere el café sin azúcar", now, now);

    const hit = db
      .prepare("SELECT m.id FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid WHERE memories_fts MATCH ?")
      .get("cafe") as { id: string } | undefined;
    expect(hit?.id).toBe("m1");

    db.prepare("DELETE FROM memories WHERE id = 'm1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'cafe'").get()).toEqual({ n: 0 });
  });

  it("enforces agreement status values", () => {
    const db = openMigratedDatabase(":memory:");
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          "INSERT INTO agreements (id, title, status, source_type, created_at, updated_at) VALUES ('a1', 'Partido', 'maybe', 'whatsapp', ?, ?)",
        )
        .run(now, now),
    ).toThrow();
  });
});
