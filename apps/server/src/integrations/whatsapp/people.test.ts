import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { WhatsAppReader } from "./message-reader.js";
import { nameMatch, WhatsAppPeople } from "./people.js";

const NOW = new Date("2026-11-27T15:00:00Z");
const LU = "5491100000001@s.whatsapp.net";
const LUCIA = "5491100000002@s.whatsapp.net";
const LUCRECIA = "5491100000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function setup() {
  const db = openMigratedDatabase(":memory:");
  const chat = (jid: string, name: string, group = false) =>
    db.prepare("INSERT INTO wa_chats (jid, name, is_group, updated_at) VALUES (?, ?, ?, ?)").run(jid, name, group ? 1 : 0, NOW.toISOString());
  let n = 0;
  const message = (chatJid: string, options: { daysAgo: number; fromMe?: boolean; sender?: string; senderName?: string }) => {
    const at = new Date(NOW.getTime() - options.daysAgo * 86_400_000).toISOString();
    db.prepare(
      "INSERT INTO wa_messages (id, chat_jid, sender_jid, sender_name, from_me, ts_utc, text, kind, edited, deleted, source, inserted_at) VALUES (?, ?, ?, ?, ?, ?, 'hola', 'text', 0, 0, 'baileys', ?)",
    ).run(`m${n++}`, chatJid, options.fromMe ? null : (options.sender ?? chatJid), options.fromMe ? null : (options.senderName ?? null), options.fromMe ? 1 : 0, at, at);
  };
  const talk = (jid: string, times: number, daysAgo: number) => {
    for (let i = 0; i < times; i++) message(jid, { daysAgo, fromMe: i % 2 === 0 });
  };
  return { db, chat, message, talk, people: new WhatsAppPeople(db, () => NOW) };
}

describe("names", () => {
  it("fits a whole name best, then a word of it, then the start of a word", () => {
    expect(nameMatch("lu", "Lu")).toBe(3);
    expect(nameMatch("Lu", "Lu Gómez 🌻")).toBe(2);
    expect(nameMatch("lu", "Lucía Pérez")).toBe(1.5);
    expect(nameMatch("lu", "Raúl")).toBe(0);
    expect(nameMatch("l", "Lucía")).toBe(0);
  });
});

describe("WhatsApp people", () => {
  it("finds someone by the name they use in a group, as the same person as their saved contact", () => {
    const { db, chat, message, people } = setup();
    chat(LU, "Luli facu");
    chat(GROUP, "Fútbol jueves", true);
    db.prepare("INSERT INTO wa_lid_map (lid, jid, updated_at) VALUES ('99887766@lid', ?, ?)").run(LU, NOW.toISOString());
    message(GROUP, { daysAgo: 2, sender: "99887766@lid", senderName: "Lu Gómez" });
    const [found, ...rest] = people.find("Lu Gómez");
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ jid: LU, name: "Luli facu", also: ["Lu Gómez"], group: "Fútbol jueves" });
  });

  it("picks the one the owner talks with and asks only among people they talk with", () => {
    const { chat, talk, people } = setup();
    chat(LU, "Lu");
    chat(LUCIA, "Lucía Pérez");
    chat(LUCRECIA, "Lucrecia");
    talk(LUCIA, 30, 1);
    expect(people.pick("lu")).toMatchObject({ person: { jid: LUCIA } });
    talk(LUCRECIA, 30, 2);
    const pick = people.pick("lu");
    expect("choices" in pick && pick.choices.map((person) => person.jid)).toEqual([LUCIA, LUCRECIA]);
  });

  it("does not ask when one fits far better than the rest", () => {
    const { chat, talk, people } = setup();
    chat(LU, "Lu");
    chat(LUCIA, "Lucía Pérez");
    talk(LU, 40, 0);
    talk(LUCIA, 1, 50);
    expect(people.pick("lu")).toMatchObject({ person: { jid: LU } });
    expect(people.pick("Martina")).toEqual({ none: true });
  });

  it("sends to someone known only from a group, by number, or by a hidden id", () => {
    const { db, chat, message } = setup();
    chat(GROUP, "Fútbol jueves", true);
    db.prepare("INSERT INTO wa_lid_map (lid, jid, updated_at) VALUES ('99887766@lid', ?, ?)").run(LU, NOW.toISOString());
    message(GROUP, { daysAgo: 1, sender: "99887766@lid", senderName: "Lu Gómez" });
    message(GROUP, { daysAgo: 1, sender: "11223344@lid", senderName: "Gero" });
    const reader = new WhatsAppReader(db, "America/Argentina/Buenos_Aires");
    expect(reader.resolveChat("lu gomez", { liveOnly: true })).toEqual({ jid: LU, name: "Lu Gómez" });
    expect(reader.resolveChat("+54 9 11 0000-0001", { liveOnly: true })).toEqual({ jid: "5491100000001@s.whatsapp.net", name: "Lu Gómez" });
    expect(reader.resolveChat("gero", { liveOnly: true })).toEqual({ jid: "11223344@lid", name: "Gero" });
    expect(reader.resolveChat("fútbol jueves", { liveOnly: true })).toEqual({ jid: GROUP, name: "Fútbol jueves" });
  });
});
