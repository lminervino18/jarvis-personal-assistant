import type { Card, HistoryItem } from "@jarvis/contracts";
import type { Logger } from "pino";
import type { Db } from "../db/database.js";
import type { ConversationHub } from "../conversation/hub.js";

const DEFAULT_INTERVAL_MS = 2000;

interface SystemMessageRow {
  rid: number;
  id: string;
  conversation_id: string;
  content: string;
  cards_json: string;
  created_at: string;
}

function toHistoryItem(row: SystemMessageRow): HistoryItem {
  return {
    id: row.id,
    turnId: null,
    role: "system",
    text: row.content,
    at: row.created_at,
    interrupted: false,
    cards: JSON.parse(row.cards_json) as Card[],
  };
}

/**
 * The worker writes reminder messages straight into the database. This feed polls for system messages
 * without a turn that appeared since the server started and pushes them to connected clients as history items.
 */
export class SystemMessageFeed {
  private cursor: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly hub: ConversationHub,
    private readonly log: Pick<Logger, "error">,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    this.cursor = (db.prepare("SELECT COALESCE(MAX(rid), 0) AS rid FROM messages").get() as { rid: number }).rid;
  }

  start(): void {
    this.timer = setInterval(() => this.safePoll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Emits every new system message, grouped per conversation. Returns how many were emitted. */
  poll(): number {
    const rows = this.db
      .prepare("SELECT rid, id, conversation_id, content, cards_json, created_at FROM messages WHERE rid > ? AND role = 'system' AND turn_id IS NULL ORDER BY rid")
      .all(this.cursor) as SystemMessageRow[];
    const byConversation = new Map<string, HistoryItem[]>();
    for (const row of rows) {
      byConversation.set(row.conversation_id, [...(byConversation.get(row.conversation_id) ?? []), toHistoryItem(row)]);
      this.cursor = row.rid;
    }
    for (const [conversationId, items] of byConversation) {
      this.hub.emit(conversationId, { type: "history", conversationId, items, hasMore: false });
    }
    return rows.length;
  }

  private safePoll(): void {
    try {
      this.poll();
    } catch (error) {
      this.log.error({ err: error instanceof Error ? error.message : "unknown" }, "system message feed failed");
    }
  }
}
