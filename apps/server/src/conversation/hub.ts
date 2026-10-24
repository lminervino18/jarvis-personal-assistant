import type { OutgoingServerMessage } from "@jarvis/contracts";

export interface Subscriber {
  send(message: OutgoingServerMessage): void;
}

/** Fans out conversation events to every connected client watching that conversation. */
export class ConversationHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(conversationId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(conversationId);
    };
  }

  emit(conversationId: string, message: OutgoingServerMessage): void {
    for (const subscriber of this.subscribers.get(conversationId) ?? []) subscriber.send(message);
  }

  /** Sends to every connected client, regardless of conversation (e.g. fired reminders). */
  broadcast(message: OutgoingServerMessage): void {
    for (const set of this.subscribers.values()) for (const subscriber of set) subscriber.send(message);
  }
}
