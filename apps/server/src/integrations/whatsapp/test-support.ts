import { readFileSync } from "node:fs";
import { openMigratedDatabase } from "../../db/database.js";
import { importExport } from "./importer.js";

export const TIMEZONE = "America/Argentina/Buenos_Aires";
export const IMPORT_TIME = new Date("2026-10-26T12:00:00Z");

export function loadExport(name: string): string {
  return readFileSync(new URL(`../../../fixtures/synthetic/whatsapp/${name}`, import.meta.url), "utf8");
}

export function seededDatabase() {
  const db = openMigratedDatabase(":memory:");
  const group = importExport(db, { text: loadExport("android-es-group.txt"), chatName: "Cena de prueba", timezone: TIMEZONE, me: "Loren Prueba", now: IMPORT_TIME });
  const direct = importExport(db, { text: loadExport("ios-es.txt"), chatName: "Ana Prueba", timezone: TIMEZONE, me: "Loren Prueba", now: IMPORT_TIME });
  return { db, group, direct };
}

export function loadBaileysFixture<T = unknown>(): T {
  return JSON.parse(loadExport("baileys-events.json")) as T;
}
