import { z } from "zod";

export const NOTIFICATION_TITLE = "J.A.R.V.IS";
export const SENSITIVE_BODY = "Tenés un recordatorio.";
const MAX_BODY_LENGTH = 140;

/** What the service worker receives. Built when the reminder fires, so private text never reaches the outbox. */
export const PushNotification = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  url: z.string(),
});
export type PushNotification = z.infer<typeof PushNotification>;

export function reminderNotification(reminder: { id: string; text: string; sensitive: boolean }): PushNotification {
  const text = reminder.text.trim();
  const body = reminder.sensitive ? SENSITIVE_BODY : text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH - 1)}…` : text;
  return { title: NOTIFICATION_TITLE, body, tag: `reminder:${reminder.id}`, url: "/" };
}

export function missedRemindersNotification(count: number): PushNotification {
  const body = count === 1 ? "Se te pasó un recordatorio mientras no estaba disponible." : `Se te pasaron ${count} recordatorios mientras no estaba disponible.`;
  return { title: NOTIFICATION_TITLE, body, tag: "reminders:missed", url: "/" };
}
