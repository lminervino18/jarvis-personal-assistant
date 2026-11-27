import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { BridgeMonitor } from "./bridge-monitor.js";
import { WhatsAppStore } from "./message-store.js";

const START = new Date("2026-11-27T04:14:00Z");

function setup() {
  const db = openMigratedDatabase(":memory:");
  let clock = START;
  const monitor = new BridgeMonitor(db, () => clock);
  const store = new WhatsAppStore(db);
  const at = (minutes: number) => (clock = new Date(START.getTime() + minutes * 60_000));
  const notices = () =>
    (db.prepare("SELECT kind, payload_json AS payload FROM outbox ORDER BY kind").all() as { kind: string; payload: string }[]).map((row) => ({
      kind: row.kind,
      text: (JSON.parse(row.payload) as { body?: string; text?: string }).body ?? (JSON.parse(row.payload) as { text?: string }).text,
    }));
  return { monitor, store, at, notices };
}

describe("WhatsApp bridge monitor", () => {
  it("tells the owner once, by push and in the chat, as soon as WhatsApp has to be linked again", () => {
    const { monitor, store, notices } = setup();
    store.setStatus("baileys", "logged_out", START, "WhatsApp invalidó la sesión.");
    monitor.check();
    monitor.check();
    const text = "Se desvinculó WhatsApp. Abrí Configuración: ahí te dejo el QR para escanearlo de nuevo.";
    expect(notices()).toEqual([
      { kind: "chat_message", text },
      { kind: "push", text },
    ]);
  });

  it("gives a connection that keeps retrying a quarter of an hour, and forgets the fall once it is back", () => {
    const { monitor, store, at, notices } = setup();
    store.setStatus("baileys", "disconnected", START, "Reconectando (intento 1).");
    monitor.check();
    at(10);
    monitor.check();
    expect(notices()).toEqual([]);
    at(16);
    monitor.check();
    expect(notices()[0]?.text).toBe("WhatsApp está sin conexión hace un rato. Sigo intentando solo; si querés probar ya, abrí Configuración.");
    store.setStatus("baileys", "connected", at(17));
    monitor.check();
    store.setStatus("baileys", "error", at(7 * 60), "WhatsApp rechazó la conexión (403).");
    monitor.check();
    expect(notices().filter((notice) => notice.kind === "push")).toHaveLength(2);
  });

  it("counts a connected bridge that stopped beating as down, and stays quiet while the owner scans", () => {
    const { monitor, store, at, notices } = setup();
    store.setStatus("baileys", "pairing", START);
    at(60);
    monitor.check();
    store.setStatus("baileys", "connected", at(61));
    at(70);
    monitor.check();
    expect(notices()).toEqual([]);
    at(90);
    monitor.check();
    expect(notices()).toHaveLength(2);
  });
});
