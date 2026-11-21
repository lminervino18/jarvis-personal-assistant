import { z } from "zod";
import { ReviewVerdict, TaskBlocker, TaskPhase, TaskStatus } from "./tasks.js";

const IsoDateTime = z.iso.datetime({ offset: true });

export const YoutubeCard = z.object({
  kind: z.literal("youtube"),
  requestId: z.string(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string(),
  channel: z.string().optional(),
  url: z.url(),
  thumbnailUrl: z.url().optional(),
  autoplay: z.boolean(),
});

export const SourcesCard = z.object({
  kind: z.literal("sources"),
  items: z.array(z.object({ title: z.string(), url: z.url().optional(), source: z.string(), date: z.string().optional() })),
});

export const ReminderCard = z.object({
  kind: z.literal("reminder"),
  reminderId: z.string(),
  text: z.string(),
  dueAt: IsoDateTime,
  timezone: z.string(),
  status: z.enum(["scheduled", "fired", "cancelled", "missed"]),
});

export const EventCard = z.object({
  kind: z.literal("event"),
  eventId: z.string(),
  title: z.string(),
  start: IsoDateTime,
  end: IsoDateTime.optional(),
  timezone: z.string(),
  location: z.string().optional(),
});

export const ConfirmCard = z.object({
  kind: z.literal("confirm"),
  actionId: z.string(),
  title: z.string(),
  summary: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  expiresAt: IsoDateTime,
  status: z.enum(["pending", "confirmed", "rejected", "expired", "failed"]),
});

export const IntegrationProvider = z.enum(["claude", "gmail", "whatsapp", "calendar", "reminders", "youtube", "push", "voice", "agents"]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const IntegrationCard = z.object({
  kind: z.literal("integration"),
  provider: IntegrationProvider,
  account: z.string().optional(),
  status: z.enum(["connected", "disconnected", "needs_action", "error", "disabled"]),
  message: z.string(),
  actionUrl: z.string().optional(),
  actionLabel: z.string().optional(),
});

export const PairingCard = z.object({
  kind: z.literal("pairing"),
  provider: z.literal("whatsapp"),
  qr: z.string().optional(),
  code: z.string().optional(),
  expiresAt: IsoDateTime,
});

export const PushPermissionCard = z.object({
  kind: z.literal("push_permission"),
  reason: z.string(),
});

export const LinkCard = z.object({
  kind: z.literal("link"),
  url: z.url(),
  title: z.string(),
  description: z.string().optional(),
});

/** A delegated task as the owner sees it in the chat. Built by the server from the task store. */
export const TaskCard = z.object({
  kind: z.literal("task"),
  taskId: z.uuid(),
  ref: z.number().int().positive(),
  title: z.string(),
  status: TaskStatus,
  phase: TaskPhase.nullable(),
  paused: z.boolean(),
  iteration: z.number().int().nonnegative(),
  summary: z.string().optional(),
  blocker: TaskBlocker.optional(),
  review: z
    .object({ verdict: ReviewVerdict, passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .optional(),
  deliverables: z.array(z.object({ path: z.string(), description: z.string() })).max(20).optional(),
  costUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
  updatedAt: IsoDateTime,
});

export const Card = z.discriminatedUnion("kind", [
  YoutubeCard,
  SourcesCard,
  ReminderCard,
  EventCard,
  ConfirmCard,
  IntegrationCard,
  PairingCard,
  PushPermissionCard,
  LinkCard,
  TaskCard,
]);
export type Card = z.infer<typeof Card>;
