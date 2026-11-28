import { z } from "zod";
import { MediaFormat } from "./media.js";
import { PublicationStatus, ReviewVerdict, TaskBlocker, TaskPhase, TaskStatus, TaskTarget } from "./tasks.js";
import { VideoFile, VideoFormat, VideoSendState, VideoStatus } from "./videos.js";

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

export const IntegrationProvider = z.enum(["claude", "gmail", "whatsapp", "calendar", "reminders", "youtube", "push", "voice", "agents", "github", "vercel", "drive"]);
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

/** A file the owner attached to a message (a photo, a PDF), shown in their bubble. */
export const AttachmentCard = z.object({
  kind: z.literal("attachment"),
  attachmentId: z.uuid(),
  name: z.string().max(200),
  mediaType: z.string().max(100),
  size: z.number().int().nonnegative(),
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
  /** A change to JARVIS itself, which the owner can publish. */
  build: z.boolean().optional(),
  /** A repository or new project the owner can ship the result to. */
  target: TaskTarget.optional(),
  /** The owner removed it from build mode. */
  archived: z.boolean().optional(),
  publication: z
    .object({
      status: PublicationStatus,
      step: z.string().max(40).optional(),
      commit: z.string().max(40).optional(),
      message: z.string().max(600).optional(),
      /** The pull request or the published site. */
      url: z.string().max(500).optional(),
    })
    .optional(),
  updatedAt: IsoDateTime,
});

/** A narrated video JARVIS makes, as the owner sees it in the chat: progress, preview and the files to share. */
export const VideoCard = z.object({
  kind: z.literal("video"),
  videoId: z.uuid(),
  version: z.number().int().positive(),
  title: z.string().max(80),
  format: VideoFormat,
  status: VideoStatus,
  progress: z.number().min(0).max(1),
  durationMs: z.number().int().nonnegative().optional(),
  files: z.object({
    full: VideoFile.optional(),
    light: VideoFile.optional(),
    thumbnail: z.uuid().optional(),
    srt: z.uuid().optional(),
    vtt: z.uuid().optional(),
  }),
  error: z.string().max(300).optional(),
  /** The send the owner asked for together with the video; their tap on the card sends it. */
  send: VideoSendState.optional(),
  updatedAt: IsoDateTime,
});
export type VideoCard = z.infer<typeof VideoCard>;

export const ChartKind = z.enum(["bar", "line", "area", "pie", "progress"]);
export type ChartKind = z.infer<typeof ChartKind>;

/** Data for a chart the assistant shows in the chat. Every series has one value per label; "progress" reads values as percentages. */
export const ChartShape = {
  title: z.string().min(1).max(80),
  chart: ChartKind,
  labels: z.array(z.string().min(1).max(40)).min(1).max(120),
  series: z
    .array(z.object({ name: z.string().min(1).max(40), values: z.array(z.number().finite()).min(1).max(120) }))
    .min(1)
    .max(10),
  unit: z.string().max(12).optional(),
  note: z.string().max(200).optional(),
};

export const ChartCard = z.object({ kind: z.literal("chart"), ...ChartShape });

/** A small table the assistant shows in the chat; cells are plain text. */
export const TableShape = {
  title: z.string().min(1).max(80),
  columns: z.array(z.string().min(1).max(40)).min(1).max(16),
  rows: z.array(z.array(z.string().max(200)).max(16)).max(300),
  note: z.string().max(200).optional(),
};

export const TableCard = z.object({ kind: z.literal("table"), ...TableShape });

/** Up to three YouTube videos that may be what the owner asked for; tapping one downloads it. */
export const MediaChoiceCard = z.object({
  kind: z.literal("media_choice"),
  choiceId: z.uuid(),
  format: MediaFormat,
  /** Who gets the file once it is downloaded, as the owner calls them. */
  sendTo: z.string().optional(),
  options: z
    .array(
      z.object({
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
        title: z.string(),
        channel: z.string().optional(),
        /** Seconds. */
        duration: z.number().int().nonnegative().optional(),
        thumbnailUrl: z.url(),
      }),
    )
    .min(1)
    .max(3),
  chosen: z.number().int().min(0).max(2).optional(),
  expiresAt: IsoDateTime,
});

/** Up to three people the owner may mean by a name; tapping one tells Jarvis which. */
export const PersonChoiceCard = z.object({
  kind: z.literal("person_choice"),
  /** The name the owner said. */
  query: z.string().max(120),
  options: z
    .array(
      z.object({
        /** Their WhatsApp chat id: the phone one, or the hidden one (…@lid) while the number is unknown. */
        chatId: z.string().regex(/^\d{6,20}@(s\.whatsapp\.net|lid)$/),
        name: z.string().max(120),
        /** What tells them apart: their number, when they last talked, a group where they write. */
        detail: z.string().max(200),
      }),
    )
    .min(2)
    .max(3),
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
  ChartCard,
  TableCard,
  AttachmentCard,
  VideoCard,
  MediaChoiceCard,
  PersonChoiceCard,
]);
export type Card = z.infer<typeof Card>;
