import { z } from "zod";

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

export const IntegrationProvider = z.enum(["claude", "gmail", "whatsapp", "calendar", "reminders", "youtube", "push", "voice"]);
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
]);
export type Card = z.infer<typeof Card>;
