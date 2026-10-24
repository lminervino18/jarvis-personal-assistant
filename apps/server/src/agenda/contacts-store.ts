import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";
import { normalizeText } from "./normalize.js";

const NICKNAMES: Record<string, string[]> = {
  pepe: ["jose"],
  paco: ["francisco"],
  pancho: ["francisco"],
  nacho: ["ignacio"],
  lucho: ["luis"],
  juancho: ["juan"],
  juani: ["juan", "juana"],
  fede: ["federico"],
  santi: ["santiago"],
  guille: ["guillermo"],
  mati: ["matias"],
  seba: ["sebastian"],
  nico: ["nicolas"],
  ale: ["alejandro", "alejandra"],
  flor: ["florencia"],
  vicky: ["victoria"],
  caro: ["carolina"],
  tomi: ["tomas"],
  facu: ["facundo"],
  agus: ["agustin", "agustina"],
  gaby: ["gabriel", "gabriela"],
  dani: ["daniel", "daniela"],
  sofi: ["sofia"],
  cami: ["camila"],
  manu: ["manuel", "manuela"],
};

export type AliasSource = "owner" | "whatsapp" | "gmail" | "import";
export type IdentityKind = "whatsapp_jid" | "email" | "phone";
export type ContactMatchKind = "exact" | "partial" | "nickname";

export interface Contact {
  id: string;
  displayName: string;
  aliases: string[];
  identities: { kind: IdentityKind; value: string }[];
}

export interface ContactMatch extends Contact {
  match: ContactMatchKind;
}

export interface NewContact {
  displayName: string;
  notes?: string;
  aliases?: string[];
  aliasSource?: AliasSource;
  identities?: { kind: IdentityKind; value: string }[];
}

interface CandidateRow {
  id: string;
  display_name: string;
  alias_normalized: string | null;
}

const MATCH_ORDER: ContactMatchKind[] = ["exact", "partial", "nickname"];

function containsWords(name: string, words: string): boolean {
  return ` ${name} `.includes(` ${words} `);
}

function matchKind(names: string[], query: string): ContactMatchKind | undefined {
  if (names.includes(query)) return "exact";
  if (names.some((name) => containsWords(name, query))) return "partial";
  const formalNames = NICKNAMES[query] ?? [];
  if (formalNames.some((formal) => names.some((name) => containsWords(name, formal)))) return "nickname";
  return undefined;
}

/** People the owner talks about, with aliases and identities. People are never merged automatically. */
export class ContactStore {
  constructor(private readonly db: Db) {}

  create(input: NewContact, now = new Date()): Contact {
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO contacts (id, display_name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, input.displayName, input.notes ?? null, at, at);
      const addAlias = this.db.prepare(
        "INSERT OR IGNORE INTO contact_aliases (contact_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?)",
      );
      for (const alias of input.aliases ?? []) addAlias.run(id, alias, normalizeText(alias), input.aliasSource ?? "owner");
      const addIdentity = this.db.prepare("INSERT INTO contact_identities (contact_id, kind, value) VALUES (?, ?, ?)");
      for (const identity of input.identities ?? []) addIdentity.run(id, identity.kind, identity.value);
    })();
    return this.get(id) as Contact;
  }

  get(id: string): Contact | undefined {
    const row = this.db.prepare("SELECT id, display_name FROM contacts WHERE id = ?").get(id) as
      | { id: string; display_name: string }
      | undefined;
    if (!row) return undefined;
    const aliases = this.db.prepare("SELECT alias FROM contact_aliases WHERE contact_id = ? ORDER BY alias").all(id) as { alias: string }[];
    const identities = this.db
      .prepare("SELECT kind, value FROM contact_identities WHERE contact_id = ? ORDER BY kind, value")
      .all(id) as Contact["identities"];
    return { id: row.id, displayName: row.display_name, aliases: aliases.map((a) => a.alias), identities };
  }

  missingIds(ids: readonly string[]): string[] {
    const exists = this.db.prepare("SELECT 1 FROM contacts WHERE id = ?");
    return ids.filter((id) => !exists.get(id));
  }

  /**
   * Finds every plausible person for a name, alias or nickname, ignoring case and accents.
   * Only the strongest match tier is returned (exact, then partial words, then nicknames).
   */
  resolve(name: string, limit = 10): ContactMatch[] {
    const query = normalizeText(name);
    if (!query) return [];
    const matches = [...this.candidateNames()].flatMap(([id, names]) => {
      const match = matchKind(names, query);
      return match ? [{ id, match }] : [];
    });
    const best = MATCH_ORDER.find((kind) => matches.some((m) => m.match === kind));
    return matches
      .filter((m) => m.match === best)
      .map((m) => ({ ...(this.get(m.id) as Contact), match: m.match }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"))
      .slice(0, limit);
  }

  private candidateNames(): Map<string, string[]> {
    const rows = this.db
      .prepare("SELECT c.id, c.display_name, a.alias_normalized FROM contacts c LEFT JOIN contact_aliases a ON a.contact_id = c.id")
      .all() as CandidateRow[];
    const names = new Map<string, string[]>();
    for (const row of rows) {
      const list = names.get(row.id) ?? [normalizeText(row.display_name)];
      if (row.alias_normalized) list.push(row.alias_normalized);
      names.set(row.id, list);
    }
    return names;
  }
}
