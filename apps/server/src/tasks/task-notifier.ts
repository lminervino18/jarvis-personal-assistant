import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE, type PushNotification } from "../push/notification.js";
import type { ChatPayload } from "../worker/chat-messages.js";
import { Outbox } from "../worker/outbox.js";
import { taskCard } from "./task-service.js";
import type { TaskStore } from "./task-store.js";

const CURSOR = "task_events";

/**
 * Turns notifiable task events from the work database into chat messages and Web Push
 * entries in the personal outbox. Dedupe keys make a repeat after a crash harmless; the
 * push body carries only the task number, never its content.
 */
export class TaskNotifier {
  private readonly outbox: Outbox;

  constructor(
    private readonly personalDb: Db,
    private readonly tasks: TaskStore,
  ) {
    this.outbox = new Outbox(personalDb);
  }

  runOnce(now: Date): number {
    const cursor = this.cursor();
    const events = this.tasks.notifiableEvents(cursor);
    for (const event of events) {
      const task = this.tasks.get(event.taskId);
      if (task) {
        const chat: ChatPayload = { text: event.message, cards: [taskCard(task, this.tasks.publication(task.id))] };
        const push: PushNotification = { title: NOTIFICATION_TITLE, body: event.message, tag: `task:${task.id}`, url: "/" };
        this.outbox.enqueue({ kind: "chat_message", dedupeKey: `task-event:${event.id}:chat`, payload: chat }, now);
        this.outbox.enqueue({ kind: "push", dedupeKey: `task-event:${event.id}:push`, payload: push }, now);
      }
      this.saveCursor(event.id, now);
    }
    return events.length;
  }

  private cursor(): number {
    const row = this.personalDb.prepare("SELECT value FROM sync_cursors WHERE name = ?").get(CURSOR) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private saveCursor(eventId: number, now: Date): void {
    this.personalDb
      .prepare(
        `INSERT INTO sync_cursors (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(CURSOR, String(eventId), now.toISOString());
  }
}
