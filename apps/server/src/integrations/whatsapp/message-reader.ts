import type { ToolErrorCode } from "@jarvis/contracts";
import type { Db } from "../../db/database.js";
import { toFtsQuery } from "../../util/fts.js";
import { toUtcIso, toZonedIso } from "../../util/time.js";

export const MAX_TEXT_CHARS = 1500;

export class WhatsAppQueryError extends Error {
  constructor(
    readonly code: Extract<ToolErrorCode, "invalid_input" | "not_found" | "ambiguous">,
    message: string,
  ) {
    super(message);
  }
}

export interface WaMessageView {
  chatId: string;
  chatName: string | null;
  isGroup: boolean;
  messageId: string;
  sender: string | null;
  fromMe: boolean;
  timestamp: string;
  text: string;
  textTruncated: boolean;
  kind: "text" | "media" | "system";
  edited: boolean;
  deleted: boolean;
  source: "baileys" | "import";
}

export interface SourceCoverage {
  source: "baileys" | "import";
  earliest: string | null;
  latest: string | null;
  messages: number;
  status: string | null;
}

export interface WaCoverage {
  from?: string;
  to?: string;
  note: string;
  sources: SourceCoverage[];
}

export interface SearchParams {
  query: string;
  chatId?: string;
  contactId?: string;
  since?: string;
  until?: string;
  limit: number;
  cursor?: string;
}

export interface SearchPage {
  items: WaMessageView[];
  nextCursor?: string;
}

export interface MessagesParams {
  chatId: string;
  before?: string;
  after?: string;
  limit: number;
}

export interface MessagesPage {
  chat: { jid: string; name: string | null };
  items: WaMessageView[];
  hasMore: boolean;
}

interface MessageRow {
  rid: number;
  id: string;
  chat_jid: string;
  chat_name: string | null;
  is_group: number | null;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: number;
  ts_utc: string;
  text: string;
  kind: WaMessageView["kind"];
  edited: number;
  deleted: number;
  source: WaMessageView["source"];
  score?: number;
}

const COLUMNS = `m.rid AS rid, m.id AS id, m.chat_jid AS chat_jid, c.name AS chat_name, c.is_group AS is_group,
  m.sender_jid AS sender_jid, m.sender_name AS sender_name, m.from_me AS from_me, m.ts_utc AS ts_utc, m.text AS text,
  m.kind AS kind, m.edited AS edited, m.deleted AS deleted, m.source AS source`;

const CONTACT_ALIASES = "SELECT alias FROM contact_aliases WHERE contact_id = @contact UNION SELECT display_name FROM contacts WHERE id = @contact";
const CONTACT_JIDS = "SELECT value FROM contact_identities WHERE contact_id = @contact AND kind = 'whatsapp_jid'";
const CONTACT_FILTER = `AND (c.contact_id = @contact
  OR m.chat_jid IN (${CONTACT_JIDS}) OR m.sender_jid IN (${CONTACT_JIDS})
  OR m.sender_name COLLATE NOCASE IN (${CONTACT_ALIASES})
  OR (c.is_group = 0 AND c.name COLLATE NOCASE IN (${CONTACT_ALIASES})))`;

function encodeCursor(row: MessageRow): string {
  return Buffer.from(JSON.stringify({ s: row.score, r: row.rid })).toString("base64url");
}

function decodeCursor(cursor: string): { score: number; rid: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown; r?: unknown };
    if (typeof parsed.s !== "number" || typeof parsed.r !== "number") throw new Error("bad cursor");
    return { score: parsed.s, rid: parsed.r };
  } catch {
    throw new WhatsAppQueryError("invalid_input", "El cursor de paginación no es válido.");
  }
}

/** Read side of the WhatsApp tables: search, chronological reads and coverage. */
export class WhatsAppReader {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
  ) {}

  search(params: SearchParams): SearchPage {
    const match = toFtsQuery(params.query);
    if (!match) throw new WhatsAppQueryError("invalid_input", "La consulta no tiene términos buscables.");
    const cursor = params.cursor ? decodeCursor(params.cursor) : undefined;
    const filters = this.filters(params);
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ${COLUMNS}, bm25(wa_messages_fts) AS score
           FROM wa_messages_fts JOIN wa_messages m ON m.rid = wa_messages_fts.rowid LEFT JOIN wa_chats c ON c.jid = m.chat_jid
           WHERE wa_messages_fts MATCH @match AND m.deleted = 0 AND m.kind != 'system' ${filters.sql}
         )
         WHERE @cursorRid IS NULL OR score > @cursorScore OR (score = @cursorScore AND rid > @cursorRid)
         ORDER BY score, rid LIMIT @limit`,
      )
      .all({ ...filters.values, match, cursorScore: cursor?.score ?? null, cursorRid: cursor?.rid ?? null, limit: params.limit + 1 }) as MessageRow[];
    const page = rows.slice(0, params.limit);
    const last = page.at(-1);
    return { items: page.map((row) => this.present(row)), nextCursor: rows.length > params.limit && last ? encodeCursor(last) : undefined };
  }

  messages(params: MessagesParams): MessagesPage {
    const chat = this.resolveChat(params.chatId);
    const oldestFirst = params.after !== undefined && params.before === undefined;
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM wa_messages m LEFT JOIN wa_chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = @chat AND (@before IS NULL OR m.ts_utc <= @before) AND (@after IS NULL OR m.ts_utc >= @after)
         ORDER BY m.ts_utc ${oldestFirst ? "ASC" : "DESC"}, m.rid ${oldestFirst ? "ASC" : "DESC"} LIMIT @limit`,
      )
      .all({
        chat: chat.jid,
        before: params.before ? toUtcIso(params.before) : null,
        after: params.after ? toUtcIso(params.after) : null,
        limit: params.limit + 1,
      }) as MessageRow[];
    const page = rows.slice(0, params.limit);
    return { chat, items: (oldestFirst ? page : page.reverse()).map((row) => this.present(row)), hasMore: rows.length > params.limit };
  }

  coverage(chatId?: string): WaCoverage {
    const chat = chatId ? this.resolveChat(chatId) : undefined;
    const stats = this.db
      .prepare(
        `SELECT source, MIN(ts_utc) AS earliest, MAX(ts_utc) AS latest, COUNT(*) AS messages FROM wa_messages
         WHERE @chat IS NULL OR chat_jid = @chat GROUP BY source`,
      )
      .all({ chat: chat?.jid ?? null }) as Omit<SourceCoverage, "status">[];
    const states = this.db.prepare("SELECT source, status FROM wa_sync_state").all() as { source: SourceCoverage["source"]; status: string }[];
    const sources = (["import", "baileys"] as const).flatMap((source): SourceCoverage[] => {
      const stat = stats.find((candidate) => candidate.source === source);
      const status = states.find((candidate) => candidate.source === source)?.status ?? null;
      return stat || status ? [{ source, earliest: stat?.earliest ?? null, latest: stat?.latest ?? null, messages: stat?.messages ?? 0, status }] : [];
    });
    return this.describeCoverage(sources, chat?.name ?? chat?.jid);
  }

  private describeCoverage(sources: SourceCoverage[], scope: string | undefined): WaCoverage {
    const earliest = sources.flatMap((source) => (source.earliest ? [source.earliest] : [])).sort()[0];
    const latest = sources.flatMap((source) => (source.latest ? [source.latest] : [])).sort().at(-1);
    const day = (utc: string) => toZonedIso(utc, this.timezone).slice(0, 10);
    const parts = sources.map((source) =>
      source.messages > 0
        ? `${source.source}: ${day(source.earliest as string)} a ${day(source.latest as string)} (${source.messages} mensajes)`
        : `${source.source}: sin mensajes${source.status ? ` (estado: ${source.status})` : ""}`,
    );
    const where = scope ? ` en el chat ${scope}` : "";
    const summary = parts.length > 0 ? `Cobertura${where} por fuente: ${parts.join("; ")}.` : `No hay mensajes de WhatsApp importados ni sincronizados${where}.`;
    return {
      from: earliest ? toZonedIso(earliest, this.timezone) : undefined,
      to: latest ? toZonedIso(latest, this.timezone) : undefined,
      note: `${summary} Que un mensaje no aparezca no prueba que no exista: solo se ve lo importado o sincronizado.`,
      sources,
    };
  }

  private filters(params: SearchParams): { sql: string; values: Record<string, string> } {
    const values: Record<string, string> = {};
    const clauses: string[] = [];
    if (params.chatId) {
      values.chat = this.resolveChat(params.chatId).jid;
      clauses.push("AND m.chat_jid = @chat");
    }
    if (params.contactId) {
      this.requireContact(params.contactId);
      values.contact = params.contactId;
      clauses.push(CONTACT_FILTER);
    }
    if (params.since) {
      values.since = toUtcIso(params.since);
      clauses.push("AND m.ts_utc >= @since");
    }
    if (params.until) {
      values.until = toUtcIso(params.until);
      clauses.push("AND m.ts_utc <= @until");
    }
    return { sql: clauses.join(" "), values };
  }

  private requireContact(contactId: string): void {
    if (!this.db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(contactId)) {
      throw new WhatsAppQueryError("not_found", "No existe un contacto con ese id.");
    }
  }

  private resolveChat(chatId: string): { jid: string; name: string | null } {
    const byJid = this.db.prepare("SELECT jid, name FROM wa_chats WHERE jid = ?").get(chatId) as { jid: string; name: string | null } | undefined;
    if (byJid) return byJid;
    const byName = this.db.prepare("SELECT jid, name FROM wa_chats WHERE name = ? COLLATE NOCASE").all(chatId) as { jid: string; name: string | null }[];
    if (byName.length === 1) return byName[0] as { jid: string; name: string | null };
    if (byName.length > 1) {
      throw new WhatsAppQueryError("ambiguous", `Hay varios chats llamados "${chatId}": ${byName.map((chat) => chat.jid).join(", ")}.`);
    }
    throw new WhatsAppQueryError("not_found", "No existe un chat con ese id o nombre.");
  }

  private present(row: MessageRow): WaMessageView {
    const truncated = row.text.length > MAX_TEXT_CHARS;
    return {
      chatId: row.chat_jid,
      chatName: row.chat_name,
      isGroup: row.is_group === 1,
      messageId: row.id,
      sender: row.sender_name ?? row.sender_jid,
      fromMe: row.from_me === 1,
      timestamp: toZonedIso(row.ts_utc, this.timezone),
      text: truncated ? `${row.text.slice(0, MAX_TEXT_CHARS).trimEnd()}…` : row.text,
      textTruncated: truncated,
      kind: row.kind,
      edited: row.edited === 1,
      deleted: row.deleted === 1,
      source: row.source,
    };
  }
}
