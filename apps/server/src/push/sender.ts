import webpush from "web-push";
import type { PushNotification } from "./notification.js";
import type { StoredSubscription } from "./subscriptions.js";
import type { VapidConfig } from "./vapid.js";

const TTL_SECONDS = 6 * 60 * 60;
const TIMEOUT_MS = 10_000;
const GONE_STATUS_CODES = [404, 410];

/** A failed delivery reduced to a code that is safe to store and log (no endpoint, no response body). */
export class PushSendError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode?: number,
  ) {
    super(code);
  }

  /** The push service says this subscription no longer exists. */
  get isGone(): boolean {
    return this.statusCode !== undefined && GONE_STATUS_CODES.includes(this.statusCode);
  }
}

export interface PushSender {
  /** Delivers one notification to one subscription. Throws PushSendError on any failure. */
  send(subscription: StoredSubscription, notification: PushNotification): Promise<void>;
}

export function createWebPushSender(vapid: VapidConfig): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(subscription, notification) {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(notification),
          { TTL: TTL_SECONDS, urgency: "high", timeout: TIMEOUT_MS },
        );
      } catch (error) {
        const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
        throw new PushSendError(statusCode ? `push_http_${statusCode}` : "push_network_error", statusCode);
      }
    },
  };
}
