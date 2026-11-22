import { randomUUID } from "node:crypto";
import type { Card, HistoryItem, ReplyMode, TurnStatus } from "@jarvis/contracts";
import type { Db } from "../db/database.js";

export interface ConversationRow {
  id: string;
  title: string | null;
  claude_session_id: string | null;
  session_turns: number;
  summary: string | null;
  summary_through_rid: number;
  updated_at: string;
}

interface MessageRow {
  id: string;
  turn_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  cards_json: string;
  interrupted: number;
  created_at: string;
  rid: number;
}

export interface PendingMessage {
  rid: number;
  role: "user" | "assistant";
  text: string;
}

export interface TurnUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

const SEED_MAX_MESSAGES = 60;
const SEED_MESSAGE_CHARS = 400;

export interface TurnMetrics {
  sttMs?: number;
  firstTextMs?: number;
  firstAudioMs?: number;
}

function toHistoryItem(row: MessageRow): HistoryItem {
  return {
    id: row.id,
    turnId: row.turn_id,
    role: row.role,
    text: row.content,
    at: row.created_at,
    interrupted: row.interrupted === 1,
    cards: JSON.parse(row.cards_json) as Card[],
  };
}

/** Durable conversation state. The database, not Claude's session files, is the source of truth. */
export class ConversationStore {
  constructor(private readonly db: Db) {}

  create(now = new Date()): ConversationRow {
    const id = randomUUID();
    const at = now.toISOString();
    this.db.prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)").run(id, at, at);
    return this.get(id) as ConversationRow;
  }

  get(id: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
  }

  latestActive(): ConversationRow | undefined {
    return this.db
      .prepare("SELECT * FROM conversations WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get() as ConversationRow | undefined;
  }

  resolveOrCreate(requestedId?: string): ConversationRow {
    return (requestedId && this.get(requestedId)) || this.latestActive() || this.create();
  }

  setSession(conversationId: string, sessionId: string | null, sessionTurns: number): void {
    this.db
      .prepare("UPDATE conversations SET claude_session_id = ?, session_turns = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, sessionTurns, new Date().toISOString(), conversationId);
  }

  setSummary(conversationId: string, summary: string, throughRid: number): void {
    this.db
      .prepare("UPDATE conversations SET summary = ?, summary_through_rid = ? WHERE id = ?")
      .run(summary, throughRid, conversationId);
  }

  lastModelTurnEndedAt(conversationId: string): Date | undefined {
    const row = this.db
      .prepare("SELECT MAX(ended_at) AS at FROM turns WHERE conversation_id = ? AND claude_session_id IS NOT NULL")
      .get(conversationId) as { at: string | null };
    return row.at ? new Date(row.at) : undefined;
  }

  /** Owner and assistant messages not yet covered by the conversation summary, oldest first. */
  unsummarized(conversationId: string, excludeTurnId?: string): PendingMessage[] {
    const rows = this.db
      .prepare(
        `SELECT rid, role, content FROM messages
         WHERE conversation_id = ? AND rid > ? AND role != 'system' AND TRIM(content) != '' AND (? IS NULL OR turn_id IS NOT ?)
         ORDER BY rid`,
      )
      .all(
        conversationId,
        this.get(conversationId)?.summary_through_rid ?? 0,
        excludeTurnId ?? null,
        excludeTurnId ?? null,
      ) as { rid: number; role: "user" | "assistant"; content: string }[];
    return rows.map((row) => ({ rid: row.rid, role: row.role, text: row.content }));
  }

  setTitleIfEmpty(conversationId: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL").run(title.slice(0, 80), conversationId);
  }

  startTurn(input: { id: string; conversationId: string; inputMode: ReplyMode; replyMode: ReplyMode; sttMs?: number }): void {
    this.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, input_mode, reply_mode, status, started_at, stt_ms)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(input.id, input.conversationId, input.inputMode, input.replyMode, new Date().toISOString(), input.sttMs ?? null);
  }

  finishTurn(
    turnId: string,
    outcome: { status: TurnStatus; errorCode?: string; sessionId?: string; tainted: boolean; usedTools: boolean; usage?: TurnUsage },
    metrics: TurnMetrics,
  ): void {
    this.db
      .prepare(
        `UPDATE turns SET status = ?, error_code = ?, claude_session_id = ?, tainted = ?, used_tools = ?, ended_at = ?,
           first_text_ms = ?, first_audio_ms = ?, input_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, output_tokens = ?
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        outcome.errorCode ?? null,
        outcome.sessionId ?? null,
        outcome.tainted ? 1 : 0,
        outcome.usedTools ? 1 : 0,
        new Date().toISOString(),
        metrics.firstTextMs ?? null,
        metrics.firstAudioMs ?? null,
        outcome.usage?.inputTokens ?? null,
        outcome.usage?.cacheReadTokens ?? null,
        outcome.usage?.cacheCreationTokens ?? null,
        outcome.usage?.outputTokens ?? null,
        turnId,
      );
  }

  getTurn(turnId: string): { conversationId: string; status: TurnStatus } | undefined {
    const row = this.db.prepare("SELECT conversation_id, status FROM turns WHERE id = ?").get(turnId) as
      | { conversation_id: string; status: TurnStatus }
      | undefined;
    return row ? { conversationId: row.conversation_id, status: row.status } : undefined;
  }

  turnMessages(turnId: string): HistoryItem[] {
    return (this.db.prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY rid").all(turnId) as MessageRow[]).map(toHistoryItem);
  }

  markInterrupted(messageId: string): void {
    this.db.prepare("UPDATE messages SET interrupted = 1 WHERE id = ?").run(messageId);
  }

  recordClientMetrics(turnId: string, firstAudioMs?: number, firstTextMs?: number): void {
    this.db
      .prepare(
        "UPDATE turns SET client_first_audio_ms = COALESCE(?, client_first_audio_ms), client_first_text_ms = COALESCE(?, client_first_text_ms) WHERE id = ?",
      )
      .run(firstAudioMs ?? null, firstTextMs ?? null, turnId);
  }

  appendMessage(input: {
    conversationId: string;
    turnId: string | null;
    role: "user" | "assistant" | "system";
    content: string;
    cards?: Card[];
    interrupted?: boolean;
  }): HistoryItem {
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, turn_id, role, content, cards_json, interrupted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.turnId,
          input.role,
          input.content,
          JSON.stringify(input.cards ?? []),
          input.interrupted ? 1 : 0,
          at,
        );
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, input.conversationId);
    })();
    return { id, turnId: input.turnId, role: input.role, text: input.content, at, interrupted: input.interrupted ?? false, cards: input.cards ?? [] };
  }

  history(conversationId: string, limit: number, beforeMessageId?: string): { items: HistoryItem[]; hasMore: boolean } {
    const before = beforeMessageId
      ? (this.db.prepare("SELECT rid FROM messages WHERE id = ?").get(beforeMessageId) as { rid: number } | undefined)?.rid
      : undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND (? IS NULL OR rid < ?) ORDER BY rid DESC LIMIT ?`,
      )
      .all(conversationId, before ?? null, before ?? null, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).reverse().map(toHistoryItem), hasMore };
  }

  /** The summary plus the messages it does not cover, rendered as plain text to seed a fresh Claude session. */
  seedContext(conversationId: string, ownerName: string, excludeTurnId?: string): string | undefined {
    const lines = this.unsummarized(conversationId, excludeTurnId)
      .slice(-SEED_MAX_MESSAGES)
      .map((message) => `${message.role === "user" ? ownerName : "J.A.R.V.IS"}: ${message.text.replace(/\s+/g, " ").slice(0, SEED_MESSAGE_CHARS)}`);
    const summary = this.get(conversationId)?.summary;
    const parts = [summary ? `Resumen previo: ${summary}` : "", ...lines].filter(Boolean);
    return parts.length ? parts.join("\n") : undefined;
  }
}
