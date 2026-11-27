import type { Db } from "../../db/database.js";

const DAY_MS = 86_400_000;
const RECENT_DAYS = 90;
/** Below this, the owner does not really talk with the person: a doubt only counts among people above it. */
const ACTIVE = 1;
/** How far ahead the best match must be to pick it without asking. */
const CLEAR_LEAD = 2;
const CHOICES = 3;

/** Someone the owner may mean, with the facts that tell people apart. */
export interface PersonMatch {
  /** Their chat id: the phone one, or the hidden one (…@lid) while the number is unknown. */
  jid: string;
  /** How the owner has them saved, else how they call themselves on WhatsApp. */
  name: string;
  /** Other names seen for them (the one they set on WhatsApp). */
  also: string[];
  lastPrivate: string | null;
  /** A group where they write, to tell namesakes apart. */
  group: string | null;
  match: number;
  activity: number;
}

export type PersonPick = { person: PersonMatch } | { choices: PersonMatch[] } | { none: true };

function foldName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * How well a name fits what the owner said: 3 the whole name, 2 every word said is a word of the
 * name («lu» in «Lu Gómez»), 1.5 every word starts a word of the name («lu» in «Lucía»), 0 otherwise.
 */
export function nameMatch(query: string, name: string): number {
  const wanted = foldName(query);
  const folded = foldName(name);
  if (!wanted || !folded) return 0;
  if (wanted === folded) return 3;
  const words = folded.split(" ");
  const said = wanted.split(" ");
  if (said.every((word) => words.includes(word))) return 2;
  if (said.every((word) => word.length >= 2 && words.some((candidate) => candidate.startsWith(word)))) return 1.5;
  return 0;
}

function daysAgo(last: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(last)) / DAY_MS);
  return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`;
}

/** A chat id as the owner and the model read it: the number for a phone id, the id itself otherwise. */
export function shownId(jid: string): string {
  return jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : jid;
}

/** What tells a person apart from namesakes, as the owner reads it. */
export function describePerson(person: PersonMatch, now: Date): string {
  const parts = [
    person.jid.endsWith("@s.whatsapp.net") ? shownId(person.jid) : undefined,
    person.lastPrivate ? `hablaron ${daysAgo(person.lastPrivate, now)}` : "nunca hablaron por privado", person.group ? `escribe en «${person.group}»` : undefined];
  return parts.filter(Boolean).join(" · ");
}

function recency(last: string | null, now: Date): number {
  if (!last) return 0;
  const days = (now.getTime() - Date.parse(last)) / DAY_MS;
  return days <= 3 ? 3 : days <= 14 ? 2 : days <= 60 ? 1 : 0;
}

interface NamedRow {
  jid: string;
  name: string;
}

/**
 * The people of the owner's WhatsApp, found by any name: how the owner saved them, and how they
 * call themselves in groups and chats. Hidden group ids (…@lid) count as the same person once the
 * bridge learned their number. Ranks by how well the name fits and how much the owner talks with them.
 */
export class WhatsAppPeople {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The name a phone id goes by: how the owner saved it, else the latest name it used on WhatsApp. */
  nameOf(jid: string): string | undefined {
    const saved = this.db.prepare("SELECT name FROM wa_chats WHERE jid = ? AND name IS NOT NULL").get(jid) as { name: string } | undefined;
    if (saved) return saved.name.trim();
    const seen = this.db
      .prepare("SELECT sender_name AS name FROM wa_messages WHERE sender_name IS NOT NULL AND (sender_jid = ? OR sender_jid IN (SELECT lid FROM wa_lid_map WHERE jid = ?)) ORDER BY ts_utc DESC LIMIT 1")
      .get(jid, jid) as { name: string } | undefined;
    return seen?.name.trim();
  }

  /** One id per person: the phone id, or the hidden one (…@lid) while its number is unknown. */
  private personOf(jid: string): string | undefined {
    if (jid.endsWith("@s.whatsapp.net")) return jid;
    if (!jid.endsWith("@lid")) return undefined;
    return (this.db.prepare("SELECT jid FROM wa_lid_map WHERE lid = ?").get(jid) as { jid: string } | undefined)?.jid ?? jid;
  }

  find(query: string): PersonMatch[] {
    const names = new Map<string, { saved?: string; seen: Set<string>; match: number }>();
    const add = (jid: string, name: string, saved: boolean) => {
      const phone = this.personOf(jid);
      const match = nameMatch(query, name);
      if (!phone) return;
      const entry = names.get(phone) ?? { seen: new Set<string>(), match: 0 };
      if (saved) entry.saved = name.trim();
      else entry.seen.add(name.trim());
      entry.match = Math.max(entry.match, match);
      names.set(phone, entry);
    };
    for (const row of this.db.prepare("SELECT jid, name FROM wa_chats WHERE is_group = 0 AND name IS NOT NULL").all() as NamedRow[]) add(row.jid, row.name, true);
    for (const row of this.db.prepare("SELECT DISTINCT sender_jid AS jid, sender_name AS name FROM wa_messages WHERE from_me = 0 AND sender_jid IS NOT NULL AND sender_name IS NOT NULL").all() as NamedRow[]) {
      add(row.jid, row.name, false);
    }
    const since = new Date(this.now().getTime() - RECENT_DAYS * DAY_MS).toISOString();
    const privateStats = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(from_me), 0) AS mine FROM wa_messages WHERE chat_jid = ? AND ts_utc > ?");
    const lastPrivate = this.db.prepare("SELECT MAX(ts_utc) AS last FROM wa_messages WHERE chat_jid = ?");
    const lastGroup = this.db.prepare(
      `SELECT m.ts_utc AS last, c.name AS name FROM wa_messages m JOIN wa_chats c ON c.jid = m.chat_jid
       WHERE m.chat_jid LIKE '%@g.us' AND (m.sender_jid = ? OR m.sender_jid IN (SELECT lid FROM wa_lid_map WHERE jid = ?))
       ORDER BY m.ts_utc DESC LIMIT 1`,
    );
    return [...names.entries()]
      .filter(([, entry]) => entry.match > 0)
      .map(([jid, entry]) => {
        const stats = privateStats.get(jid, since) as { n: number; mine: number };
        const last = (lastPrivate.get(jid) as { last: string | null }).last;
        const group = lastGroup.get(jid, jid) as { last: string; name: string | null } | undefined;
        const activity = 2 * Math.log1p(stats.n) + 3 * Math.log1p(stats.mine) + recency(last, this.now()) + 0.5 * recency(group?.last ?? null, this.now());
        const name = entry.saved ?? [...entry.seen][0] ?? `+${jid.split("@")[0]}`;
        return { jid, name, also: [...entry.seen].filter((seen) => foldName(seen) !== foldName(name)), lastPrivate: last, group: group?.name ?? null, match: entry.match, activity };
      })
      .sort((a, b) => score(b) - score(a));
  }

  /**
   * Who the owner means. With one clear candidate among the people they talk with, that one;
   * when several of those fit about as well, the likeliest three to ask about.
   */
  pick(query: string): PersonPick {
    const matches = this.find(query);
    if (matches.length === 0) return { none: true };
    const active = matches.filter((person) => person.activity >= ACTIVE);
    const pool = active.length ? active : matches;
    const [first, second] = pool;
    if (first && (!second || score(first) - score(second) >= CLEAR_LEAD)) return { person: first };
    return { choices: pool.slice(0, CHOICES) };
  }
}

function score(person: PersonMatch): number {
  return person.match * 1.5 + person.activity;
}
