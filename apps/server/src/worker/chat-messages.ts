import { Card } from "@jarvis/contracts";
import { z } from "zod";
import { formatLocal } from "../agenda/format.js";
import type { Reminder } from "../agenda/reminders-store.js";
import { toZonedIso } from "../util/time.js";

const MAX_LISTED = 10;

/** A system message to append to the most recently active conversation. */
export const ChatPayload = z.object({ text: z.string(), cards: z.array(Card) });
export type ChatPayload = z.infer<typeof ChatPayload>;

export function reminderMessage(reminder: Reminder, late: boolean): ChatPayload {
  const text = late
    ? `Recordatorio atrasado (era para el ${formatLocal(reminder.dueUtc, reminder.timezone)}): ${reminder.text}`
    : `Recordatorio: ${reminder.text}`;
  const card: Card = {
    kind: "reminder",
    reminderId: reminder.id,
    text: reminder.text,
    dueAt: toZonedIso(reminder.dueUtc, reminder.timezone),
    timezone: reminder.timezone,
    status: "fired",
  };
  return { text, cards: [card] };
}

export function missedRemindersMessage(reminders: Reminder[]): ChatPayload {
  const listed = reminders.slice(0, MAX_LISTED).map((reminder) => `- ${reminder.text} (${formatLocal(reminder.dueUtc, reminder.timezone)})`);
  const rest = reminders.length - listed.length;
  const header =
    reminders.length === 1
      ? "Se te pasó un recordatorio mientras no estaba disponible:"
      : `Se te pasaron ${reminders.length} recordatorios mientras no estaba disponible:`;
  return { text: [header, ...listed, ...(rest > 0 ? [`y ${rest} más.`] : [])].join("\n"), cards: [] };
}
