import type { Logger } from "pino";
import type { z } from "zod";
import type { Db } from "../db/database.js";
import { ConversationStore } from "../conversation/conversation-store.js";
import { PushNotification } from "../push/notification.js";
import { PushSendError, type PushSender } from "../push/sender.js";
import { PushSubscriptionStore } from "../push/subscriptions.js";
import { ChatPayload } from "./chat-messages.js";
import { Outbox, type ClaimedEntry } from "./outbox.js";

const MAX_PER_RUN = 100;

type Outcome = { status: "sent"; note?: string } | { status: "retry"; error: string } | { status: "dead"; error: string };

export interface DispatcherDeps {
  db: Db;
  log: Pick<Logger, "warn" | "error">;
  /** Absent when VAPID keys are not configured: push entries are closed without sending. */
  sender?: PushSender;
}

/**
 * Delivers outbox entries. Chat messages are appended in the same transaction that closes the entry,
 * so they land once. Push delivery is at-least-once; the notification tag makes a repeat replace the first.
 */
export class OutboxDispatcher {
  private readonly outbox: Outbox;
  private readonly subscriptions: PushSubscriptionStore;
  private readonly conversations: ConversationStore;

  constructor(private readonly deps: DispatcherDeps) {
    this.outbox = new Outbox(deps.db);
    this.subscriptions = new PushSubscriptionStore(deps.db);
    this.conversations = new ConversationStore(deps.db);
  }

  /** Delivers every entry that is due at `now`. Returns how many were handled. */
  async runOnce(now: Date): Promise<number> {
    let handled = 0;
    for (let entry = this.outbox.claim(now); entry && handled < MAX_PER_RUN; entry = this.outbox.claim(now)) {
      await this.deliver(entry, now);
      handled++;
    }
    return handled;
  }

  private async deliver(entry: ClaimedEntry, now: Date): Promise<void> {
    if (entry.kind === "chat_message") return this.finish(entry, this.deliverChat(entry, now), now);
    return this.finish(entry, await this.deliverPush(entry, now), now);
  }

  private finish(entry: ClaimedEntry, outcome: Outcome | undefined, now: Date): void {
    if (!outcome) return;
    if (outcome.status === "sent") {
      this.outbox.markSent(entry, now, outcome.note);
      return;
    }
    const result = this.outbox.markFailed(entry, outcome.error, now, outcome.status === "dead");
    if (result === "dead") this.deps.log.error({ outboxId: entry.id, kind: entry.kind, error: outcome.error }, "outbox entry is dead");
    else if (result === "retry") this.deps.log.warn({ outboxId: entry.id, kind: entry.kind, attempts: entry.attempts, error: outcome.error }, "outbox delivery failed");
  }

  private deliverChat(entry: ClaimedEntry, now: Date): Outcome | undefined {
    const payload = parsePayload(entry.payloadJson, ChatPayload);
    if (!payload) return { status: "dead", error: "invalid_payload" };
    this.deps.db
      .transaction(() => {
        if (!this.outbox.markSent(entry, now)) return;
        const conversation = this.conversations.resolveOrCreate();
        this.conversations.appendMessage({ conversationId: conversation.id, turnId: null, role: "system", content: payload.text, cards: payload.cards });
      })
      .immediate();
    return undefined;
  }

  private async deliverPush(entry: ClaimedEntry, now: Date): Promise<Outcome> {
    const notification = parsePayload(entry.payloadJson, PushNotification);
    if (!notification) return { status: "dead", error: "invalid_payload" };
    const { sender } = this.deps;
    if (!sender) return { status: "sent", note: "push_disabled" };
    const subscriptions = this.subscriptions.list();
    if (subscriptions.length === 0) return { status: "sent", note: "no_subscriptions" };

    let delivered = 0;
    const failures: string[] = [];
    for (const subscription of subscriptions) {
      try {
        await sender.send(subscription, notification);
        this.subscriptions.recordSuccess(subscription.id, now);
        delivered++;
      } catch (error) {
        const failure = error instanceof PushSendError ? error : new PushSendError("push_unknown_error");
        if (failure.isGone) {
          this.subscriptions.remove(subscription.id);
          continue;
        }
        this.subscriptions.recordFailure(subscription.id);
        failures.push(failure.code);
      }
    }
    if (delivered > 0) return { status: "sent" };
    if (failures.length === 0) return { status: "sent", note: "subscriptions_gone" };
    return { status: "retry", error: failures[0] as string };
  }
}

function parsePayload<T>(json: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
