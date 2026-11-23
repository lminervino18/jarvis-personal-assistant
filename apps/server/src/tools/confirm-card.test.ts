import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { currentConfirmCard } from "./runner.js";

const NOW = new Date("2026-11-23T12:00:00Z");

function setup() {
  const db = openMigratedDatabase(":memory:");
  const at = NOW.toISOString();
  db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', ?, ?)").run(at, at);
  const insert = (id: string, status: string, expiresAt: string) =>
    db
      .prepare(
        "INSERT INTO pending_actions (id, conversation_id, turn_id, tool, input_json, title, summary, details_json, status, created_at, expires_at) VALUES (?, 'c1', 't1', 'whatsapp_send', '{}', 'Enviar WhatsApp', 'Para Ana', '[]', ?, ?, ?)",
      )
      .run(id, status, at, expiresAt);
  const card = (actionId: string) => ({ kind: "confirm" as const, actionId, title: "Enviar WhatsApp", summary: "Para Ana", details: [], expiresAt: at, status: "pending" as const });
  return { db, insert, card };
}

describe("confirmation cards in history", () => {
  it("shows the stored decision instead of the pending snapshot", () => {
    const { db, insert, card } = setup();
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    insert("a1", "executed", later);
    insert("a2", "rejected", later);
    insert("a3", "pending", later);
    expect(currentConfirmCard(db, card("a1"), NOW).status).toBe("confirmed");
    expect(currentConfirmCard(db, card("a2"), NOW).status).toBe("rejected");
    expect(currentConfirmCard(db, card("a3"), NOW).status).toBe("pending");
  });

  it("marks a pending card whose time ran out as expired, and leaves unknown cards as they were", () => {
    const { db, insert, card } = setup();
    insert("a1", "pending", new Date(NOW.getTime() - 1).toISOString());
    expect(currentConfirmCard(db, card("a1"), NOW).status).toBe("expired");
    expect(currentConfirmCard(db, card("missing"), NOW).status).toBe("pending");
  });
});
