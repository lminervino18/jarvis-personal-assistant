import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { parseExport } from "./export-parser.js";
import { importChatJid, importExport } from "./importer.js";
import { IMPORT_TIME, TIMEZONE, loadExport, seededDatabase } from "./test-support.js";

const parse = (name: string, dateOrder?: "dmy" | "mdy") => parseExport(loadExport(name), { timezone: TIMEZONE, dateOrder });

describe("export parser", () => {
  it("parses an Android Spanish group export", () => {
    const { messages, dateOrder, unparsedLines } = parse("android-es-group.txt");
    expect(dateOrder).toBe("dmy");
    expect(unparsedLines).toBe(0);
    expect(messages.filter((message) => message.kind === "system").map((message) => message.sender)).toEqual([null, null, null]);

    const planning = messages.find((message) => message.text.startsWith("El sábado"));
    expect(planning).toMatchObject({ sender: "Beto Ejemplo", tsUtc: "2026-10-24T12:03:00.000Z", kind: "text" });
    expect(planning?.text).toBe("El sábado a las 21 me viene bien\nSi alguien trae el postre, mejor");

    expect(messages.find((message) => message.sender === "Ana Prueba" && message.kind === "media")).toMatchObject({ text: "" });
    expect(messages.find((message) => message.text === "Mirá la receta del postre")).toMatchObject({ kind: "media", sender: "Beto Ejemplo" });
    expect(messages.find((message) => message.deleted)).toMatchObject({ sender: "Loren Prueba", text: "", kind: "text" });
    expect(messages.find((message) => message.edited)).toMatchObject({ text: "Confirmo la reserva" });
  });

  it("reads 12-hour Spanish times with a. m. and p. m.", () => {
    const { messages } = parse("android-es-12h.txt");
    expect(messages.map((message) => message.tsUtc)).toEqual([
      "2026-10-05T17:05:00.000Z",
      "2026-10-05T17:06:00.000Z",
      "2026-10-06T03:15:00.000Z",
      "2026-10-14T02:59:00.000Z",
    ]);
  });

  it("parses iOS Spanish exports with invisible marks, attachments and multi-line messages", () => {
    const { messages } = parse("ios-es.txt");
    expect(messages.map((message) => message.kind)).toEqual(["text", "media", "media", "text", "text", "text"]);
    expect(messages[0]).toMatchObject({ sender: "Ana Prueba", text: "Hola Loren", tsUtc: "2026-10-24T17:05:33.000Z" });
    expect(messages[3]?.text).toBe("Esta línea tiene un salto\ny una segunda línea del mismo mensaje");
    expect(messages[4]?.text).toBe("La reunión es el 25/10 a las 10:30");
    expect(messages[5]).toMatchObject({ deleted: true, text: "" });
  });

  it("detects month-first English exports and midnight", () => {
    const { messages, dateOrder } = parse("android-en-us.txt");
    expect(dateOrder).toBe("mdy");
    expect(messages[0]).toMatchObject({ kind: "system", sender: null });
    expect(messages.map((message) => message.tsUtc)).toContain("2026-10-25T03:00:00.000Z");
    expect(messages.find((message) => message.text === "Hi Loren, are we still on for lunch?")?.tsUtc).toBe("2026-10-24T17:05:00.000Z");
    expect(messages.find((message) => message.text === "Running late")).toMatchObject({ edited: true });
    expect(messages.filter((message) => message.kind === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.deleted)).toHaveLength(1);
  });

  it("parses iOS English day-first exports", () => {
    const { messages, dateOrder } = parse("ios-en-gb.txt");
    expect(dateOrder).toBe("dmy");
    expect(messages.map((message) => message.kind)).toEqual(["text", "media", "media", "text", "text"]);
    expect(messages[3]).toMatchObject({ deleted: true });
  });

  it("resolves ambiguous dates from the locale unless told otherwise", () => {
    const spanish = parseExport("05/10/26 14:05 - A: x\n06/10/26 14:05 - A: y", { timezone: TIMEZONE });
    expect(spanish.dateOrder).toBe("dmy");
    expect(spanish.messages[0]?.tsUtc).toBe("2026-10-05T17:05:00.000Z");

    const english = parseExport("04/05/26, 2:05 PM - A: x", { timezone: TIMEZONE });
    expect(english.dateOrder).toBe("mdy");
    expect(english.messages[0]?.tsUtc).toBe("2026-04-05T17:05:00.000Z");

    const forced = parseExport("04/05/26, 2:05 PM - A: x", { timezone: TIMEZONE, dateOrder: "dmy" });
    expect(forced.messages[0]?.tsUtc).toBe("2026-05-04T17:05:00.000Z");
  });

  it("counts lines it cannot place and skips impossible dates", () => {
    const result = parseExport("texto suelto antes\n31/02/2026 10:00 - A: no existe\n24/10/2026 10:00 - A: bien", { timezone: TIMEZONE });
    expect(result.messages).toHaveLength(1);
    expect(result.unparsedLines).toBe(2);
  });
});

describe("importer", () => {
  it("stores chats, messages and coverage", () => {
    const { db, group } = seededDatabase();
    expect(group).toMatchObject({ chatJid: "import:cena-de-prueba", isGroup: true, duplicates: 0, dateOrder: "dmy" });
    expect(db.prepare("SELECT name, is_group FROM wa_chats WHERE jid = ?").get(group.chatJid)).toEqual({ name: "Cena de prueba", is_group: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM wa_messages WHERE chat_jid = ? AND from_me = 1").get(group.chatJid)).toEqual({ n: 3 });
    expect(db.prepare("SELECT status, message_count FROM wa_sync_state WHERE source = 'import'").get()).toEqual({
      status: "imported",
      message_count: group.inserted + 6,
    });
    const direct = db.prepare("SELECT is_group FROM wa_chats WHERE jid = 'import:ana-prueba'").get();
    expect(direct).toEqual({ is_group: 0 });
  });

  it("keeps identical lines apart and dedupes a re-import", () => {
    const { db, group } = seededDatabase();
    expect(db.prepare("SELECT count(*) AS n FROM wa_messages WHERE text = 'ok'").get()).toEqual({ n: 2 });

    const again = importExport(db, { text: loadExport("android-es-group.txt"), chatName: "Cena de prueba", timezone: TIMEZONE, now: IMPORT_TIME });
    expect(again).toMatchObject({ inserted: 0, duplicates: group.inserted });
    expect(db.prepare("SELECT count(*) AS n FROM wa_messages WHERE chat_jid = ?").get(group.chatJid)).toEqual({ n: group.inserted });
  });

  it("adds only the new messages of a longer, overlapping export", () => {
    const db = openMigratedDatabase(":memory:");
    const full = loadExport("android-es-group.txt");
    const firstHalf = full.split("\n").slice(0, 7).join("\n");
    const first = importExport(db, { text: firstHalf, chatName: "Cena de prueba", timezone: TIMEZONE, now: IMPORT_TIME });
    const second = importExport(db, { text: full, chatName: "Cena de prueba", timezone: TIMEZONE, now: IMPORT_TIME });
    expect(second.duplicates).toBe(first.inserted);
    expect(db.prepare("SELECT count(*) AS n FROM wa_messages").get()).toEqual({ n: first.inserted + second.inserted });
    expect(first.inserted + second.inserted).toBe(importExport(openMigratedDatabase(":memory:"), { text: full, chatName: "x", timezone: TIMEZONE }).inserted);
  });

  it("derives a stable synthetic chat id from the name", () => {
    expect(importChatJid("Cena de prueba")).toBe("import:cena-de-prueba");
    expect(importChatJid("  Ñandú & Co.  ")).toBe("import:nandu-co");
    expect(importChatJid("???")).toBe("import:chat");
  });
});
