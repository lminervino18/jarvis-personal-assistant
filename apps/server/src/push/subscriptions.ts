import { randomUUID } from "node:crypto";
import type { Db } from "../db/database.js";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export class PushEndpointError extends Error {}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface SubscriptionRow extends StoredSubscription {
  last_success_at: string | null;
  failure_count: number;
}

/**
 * Accepts only https endpoints addressed by public DNS names on the default port. IP literals,
 * single-label hosts and local suffixes are rejected so a subscription cannot aim the worker at the private network.
 */
export function assertPushEndpoint(endpoint: string): void {
  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (!url || url.protocol !== "https:") throw new PushEndpointError("El endpoint de notificaciones debe ser https.");
  if (url.username || url.password || (url.port && url.port !== "443")) throw new PushEndpointError("Endpoint de notificaciones no permitido.");
  const host = url.hostname.toLowerCase();
  const isIpLiteral = host.includes(":") || /^\d+(\.\d+){0,3}$/.test(host);
  const isLocal = !host.includes(".") || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (isIpLiteral || isLocal) throw new PushEndpointError("Endpoint de notificaciones no permitido.");
}

/** Browser push subscriptions of the owner's devices. */
export class PushSubscriptionStore {
  constructor(private readonly db: Db) {}

  /** Validates and stores a subscription; the same endpoint is updated, never duplicated. */
  save(subscription: PushSubscriptionInput, userAgent: string | undefined, now = new Date()): void {
    assertPushEndpoint(subscription.endpoint);
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           user_agent = excluded.user_agent, failure_count = 0`,
      )
      .run(randomUUID(), subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent?.slice(0, 300) ?? null, now.toISOString());
  }

  list(): StoredSubscription[] {
    const rows = this.db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, id").all() as SubscriptionRow[];
    return rows.map(({ id, endpoint, p256dh, auth }) => ({ id, endpoint, p256dh, auth }));
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
  }

  recordSuccess(id: string, now: Date): void {
    this.db.prepare("UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?").run(now.toISOString(), id);
  }

  recordFailure(id: string): void {
    this.db.prepare("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?").run(id);
  }
}
