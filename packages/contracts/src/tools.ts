import { z } from "zod";
import { ChartShape, TableShape } from "./cards.js";
import { MediaFormat } from "./media.js";
import { VideoBrief, VideoSendRequest } from "./videos.js";

const isoDateTimeWithOffset = z.iso.datetime({ offset: true });
const IsoWithOffset = z
  .string()
  .refine((value) => isoDateTimeWithOffset.safeParse(value).success, "Fecha ISO 8601 con offset inválida")
  .describe("ISO 8601 con offset");
const EntityId = z.string().min(1).max(64);
const TaskRef = z.number().int().positive();
export const ProjectSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const PageSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/);

export const MemoryCategory = z.enum(["preference", "fact", "person", "routine", "work", "other"]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const GmailAccountLabel = z.enum(["personal", "work"]);

/** Who gets a file once it is ready: a WhatsApp chat or an email address. */
export const SendFileTo = z.object({
  channel: z.enum(["whatsapp", "email"]),
  to: z.string().trim().min(1).max(254).describe("WhatsApp: id, número o nombre del chat, o «me» para el propio dueño. Email: la dirección"),
  text: z.string().trim().max(1500).optional().describe("Texto corto que acompaña al archivo; omitilo si el dueño no dijo nada"),
  subject: z.string().trim().min(1).max(200).optional(),
  account: GmailAccountLabel.optional(),
  /** A link to download it in original quality instead of the file; only when the owner asks for the link or for no quality loss. */
  asLink: z.boolean().optional(),
});
export type SendFileTo = z.infer<typeof SendFileTo>;

/** One piece of a PDF, in reading order. */
export const PdfBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: z.string().trim().min(1).max(160) }),
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("list"), items: z.array(z.string().trim().min(1).max(500)).min(1).max(40), ordered: z.boolean().optional() }),
  z.object({
    type: z.literal("table"),
    columns: z.array(z.string().trim().max(60)).min(1).max(8),
    rows: z.array(z.array(z.string().trim().max(300)).min(1).max(8)).min(1).max(100),
    caption: z.string().trim().max(200).optional(),
  }),
  z.object({
    type: z.literal("chart"),
    kind: z.enum(["bar", "line", "pie"]),
    title: z.string().trim().max(120).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).min(1).max(24),
    series: z.array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.number().finite()).min(1).max(24) })).min(1).max(5),
    /** Shown next to the values («US$», «%», «km»). */
    unit: z.string().trim().max(12).optional(),
  }),
  /** A photo from the chat (JPEG or PNG). */
  z.object({ type: z.literal("image"), attachmentId: z.uuid(), caption: z.string().trim().max(200).optional() }),
  /** A highlighted box for what matters most. */
  z.object({ type: z.literal("note"), text: z.string().trim().min(1).max(1000) }),
  z.object({ type: z.literal("link"), text: z.string().trim().min(1).max(160), url: z.url().max(500).regex(/^https?:\/\//) }),
  z.object({ type: z.literal("pagebreak") }),
]);
export type PdfBlock = z.infer<typeof PdfBlock>;
export type GmailAccountLabel = z.infer<typeof GmailAccountLabel>;

/**
 * Input shapes for every assistant tool, as zod raw shapes (the format the Agent SDK
 * `tool()` helper expects). The server validates again before executing.
 */
export const toolInputs = {
  memory_search: {
    query: z.string().min(1).max(200),
    category: MemoryCategory.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  },
  memory_update: {
    content: z.string().min(3).max(500),
    category: MemoryCategory,
    replacesMemoryId: EntityId.optional(),
  },
  memory_forget: {
    memoryId: EntityId,
    reason: z.string().max(200).optional(),
  },
  contacts_resolve: {
    name: z.string().min(1).max(80),
  },
  gmail_search: {
    account: z.enum(["personal", "work", "all"]),
    query: z.string().min(1).max(300),
    maxResults: z.number().int().min(1).max(20).optional(),
    pageToken: z.string().max(200).optional(),
  },
  gmail_get_thread: {
    account: GmailAccountLabel,
    threadId: z.string().min(1).max(64),
    lastMessages: z.number().int().min(1).max(15).optional(),
    bodyChars: z.number().int().min(200).max(4000).optional(),
  },
  whatsapp_search: {
    query: z.string().min(1).max(200),
    chatId: z.string().max(128).optional(),
    contactId: EntityId.optional(),
    since: IsoWithOffset.optional(),
    until: IsoWithOffset.optional(),
    limit: z.number().int().min(1).max(30).optional(),
    cursor: z.string().max(200).optional(),
  },
  whatsapp_get_messages: {
    chatId: z.string().min(1).max(128),
    before: IsoWithOffset.optional(),
    after: IsoWithOffset.optional(),
    limit: z.number().int().min(1).max(50).optional(),
    fullText: z.boolean().optional(),
  },
  whatsapp_send: {
    chatId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(2000),
    attachmentId: z.uuid().optional(),
  },
  calendar_list: {
    from: IsoWithOffset,
    to: IsoWithOffset,
  },
  calendar_create: {
    title: z.string().min(1).max(200),
    start: IsoWithOffset,
    end: IsoWithOffset.optional(),
    allDay: z.boolean().optional(),
    location: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
    recurrence: z.string().max(200).optional(),
  },
  calendar_update: {
    eventId: EntityId,
    title: z.string().min(1).max(200).optional(),
    start: IsoWithOffset.optional(),
    end: IsoWithOffset.optional(),
    location: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
    status: z.enum(["confirmed", "cancelled"]).optional(),
  },
  agreements_list: {
    status: z.enum(["proposed", "confirmed", "cancelled"]).optional(),
    contactId: EntityId.optional(),
    from: IsoWithOffset.optional(),
    to: IsoWithOffset.optional(),
  },
  agreements_propose: {
    title: z.string().min(1).max(200),
    details: z.string().max(1000).optional(),
    counterpartContactIds: z.array(EntityId).max(10).optional(),
    when: IsoWithOffset.optional(),
    sourceType: z.enum(["conversation", "whatsapp", "gmail"]),
    sourceRef: z.string().max(200).optional(),
  },
  agreements_confirm: {
    agreementId: EntityId,
    when: IsoWithOffset.optional(),
  },
  agreements_cancel: {
    agreementId: EntityId,
    reason: z.string().max(200).optional(),
  },
  reminders_create: {
    text: z.string().min(1).max(300),
    dueAt: IsoWithOffset,
    recurrence: z.string().max(200).optional(),
    sensitive: z.boolean().optional(),
  },
  reminders_list: {
    status: z.enum(["scheduled", "fired", "cancelled", "missed"]).optional(),
    from: IsoWithOffset.optional(),
    to: IsoWithOffset.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  reminders_update: {
    reminderId: EntityId,
    text: z.string().min(1).max(300).optional(),
    dueAt: IsoWithOffset.optional(),
    recurrence: z.string().max(200).nullable().optional(),
  },
  reminders_cancel: {
    reminderId: EntityId,
  },
  youtube_search: {
    query: z.string().min(1).max(200),
    maxResults: z.number().int().min(1).max(5).optional(),
  },
  youtube_open: {
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    autoplay: z.boolean().optional(),
  },
  youtube_play: {
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  },
  youtube_pause: {},
  integrations_status: {},
  show_chart: ChartShape,
  show_table: TableShape,
  task_create: {
    title: z.string().min(3).max(80),
    request: z.string().min(10).max(8000),
    project: ProjectSlug.optional(),
    /** An existing GitHub repository, as `owner/name` or its URL. */
    repo: z.string().min(3).max(200).optional(),
    /** A new project with its own repository and site, named with a short slug. */
    newProject: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).optional(),
    attachmentIds: z.array(z.uuid()).max(10).optional(),
  },
  task_projects: {},
  task_list: {
    filter: z.enum(["active", "finished", "all"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  },
  task_status: {
    ref: TaskRef,
  },
  task_result: {
    ref: TaskRef,
  },
  task_feedback: {
    ref: TaskRef,
    message: z.string().min(1).max(4000),
  },
  task_control: {
    ref: TaskRef,
    action: z.enum(["pause", "resume", "cancel", "retry"]),
    addBudgetUsd: z.number().positive().max(20).optional(),
  },
  gmail_send: {
    account: GmailAccountLabel.optional(),
    to: z.array(z.email().max(254)).min(1).max(10),
    cc: z.array(z.email().max(254)).max(10).optional(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    attachmentIds: z.array(z.uuid()).max(5).optional(),
  },
  whatsapp_voice_note: {
    chatId: z.string().min(1).max(128).describe("Id, número o nombre del chat; «me» para el propio dueño"),
    text: z.string().trim().min(1).max(700).describe("Lo que dice Jarvis, empezando por presentarse: «Hola Carme, soy Jarvis, el asistente de Loren…»"),
  },
  whatsapp_to_me: {
    text: z.string().trim().min(1).max(2000),
    attachmentId: z.uuid().optional(),
  },
  whatsapp_study: {
    chatIds: z.array(z.string().min(1).max(128)).min(1).max(8).describe("Chats a leer enteros: id, número o nombre"),
    focus: z.string().trim().max(300).optional().describe("En qué fijarse especialmente, si el dueño lo dijo"),
  },
  whatsapp_study_result: {
    batchId: z.uuid().optional(),
  },
  whatsapp_get_file: {
    chatId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
  },
  file_share_link: {
    attachmentId: z.uuid(),
  },
  video_create: {
    brief: VideoBrief,
    sendTo: VideoSendRequest.optional().describe("Solo si el dueño ya dijo a quién mandarlo: la tarjeta del video trae el botón para enviarlo"),
  },
  video_status: {
    videoId: z.uuid().optional(),
  },
  video_revise: {
    videoId: z.uuid(),
    brief: VideoBrief,
  },
  video_send: {
    videoId: z.uuid(),
    channel: z.enum(["whatsapp", "email"]),
    to: z.string().trim().min(1).max(254).describe("WhatsApp: id, número o nombre del chat. Email: la dirección"),
    text: z.string().trim().max(1500).optional().describe("Texto corto que acompaña al video; omitilo si el dueño lo quiere sin texto"),
    subject: z.string().trim().min(1).max(200).optional(),
    account: GmailAccountLabel.optional(),
  },
  video_page: {
    videoId: z.uuid(),
  },
  page_create: {
    title: z.string().trim().min(1).max(80),
    brief: z.string().trim().min(1).max(4000),
    attachmentIds: z.array(z.uuid()).max(6).optional(),
  },
  page_update: {
    slug: PageSlug,
    change: z.string().trim().min(1).max(4000),
    attachmentIds: z.array(z.uuid()).max(6).optional(),
  },
  drive_search: {
    /** Words in the file name; without it, the folder's contents (the Jarvis folder by default). */
    query: z.string().trim().max(200).optional(),
    /** A folder id or Drive link to list. */
    folderId: z.string().trim().max(500).optional(),
    account: GmailAccountLabel.optional(),
  },
  drive_create_folder: {
    name: z.string().trim().min(1).max(120),
    /** Parent folder id or link; the Jarvis folder by default. */
    parentId: z.string().trim().max(500).optional(),
    account: GmailAccountLabel.optional(),
  },
  drive_upload: {
    attachmentIds: z.array(z.uuid()).max(20).optional().describe("Archivos del chat: fotos, adjuntos, imágenes generadas, archivos de WhatsApp"),
    transferIds: z.array(z.uuid()).max(20).optional().describe("Archivos de Transferencias (transfer_list), de cualquier tamaño: suben en segundo plano"),
    folderId: z.string().trim().max(500).optional().describe("Carpeta de destino (id o link); la carpeta Jarvis si no se indica"),
    folderPath: z.string().trim().max(300).optional().describe("Subcarpetas dentro del destino separadas por /, por ejemplo «Solares/Fecha 3»; las que faltan se crean"),
    name: z.string().trim().min(1).max(200).optional().describe("Nombre en Drive, cuando se sube un solo archivo"),
    account: GmailAccountLabel.optional(),
  },
  drive_upload_status: {
    uploadId: z.uuid().optional(),
  },
  drive_update: {
    fileId: z.string().trim().min(1).max(500),
    name: z.string().trim().min(1).max(200).optional(),
    folderId: z.string().trim().max(500).optional(),
    account: GmailAccountLabel.optional(),
  },
  drive_share: {
    fileId: z.string().trim().min(1).max(500),
    /** Anyone with the link can view. */
    anyone: z.boolean().optional(),
    email: z.email().optional(),
    role: z.enum(["reader", "writer"]).optional(),
    account: GmailAccountLabel.optional(),
  },
  drive_download: {
    /** A Drive or Docs link (file or folder), or a file id. */
    link: z.string().trim().min(5).max(500),
    account: GmailAccountLabel.optional(),
  },
  drive_trash: {
    fileId: z.string().trim().min(1).max(500),
    account: GmailAccountLabel.optional(),
  },
  transfer_list: {},
  transfer_upload_link: {
    /** Who will use the link, as the owner calls them («Marti»); it names what arrives. */
    label: z.string().trim().min(1).max(60).optional(),
  },
  transfer_share_link: {
    transferId: z.uuid(),
  },
  transfer_from_link: {
    /** A YouTube, X or Instagram link. */
    url: z.string().trim().url().max(500).optional(),
    /** Words to search on YouTube when the owner names a song or video without a link; the first result is downloaded. */
    search: z.string().trim().min(2).max(200).optional(),
    format: MediaFormat.optional(),
    sendTo: SendFileTo.optional(),
  },
  pdf_create: {
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(200).optional(),
    blocks: z.array(PdfBlock).min(1).max(80),
    /** The file name without extension; the title by default. */
    fileName: z.string().trim().min(1).max(80).optional(),
  },
  transfer_suggest: {
    /** What the owner asked for, as words to search on YouTube («crimen cerati en vivo»). */
    query: z.string().trim().min(2).max(200),
    format: MediaFormat.optional(),
    sendTo: SendFileTo.optional(),
  },
  transfer_edit: {
    /** A YouTube, X or Instagram link to cut. */
    url: z.string().trim().url().max(500).optional(),
    /** Words to search on YouTube; the first result is cut. */
    search: z.string().trim().min(2).max(200).optional(),
    /** A video or song already in Transferencias. */
    transferId: z.uuid().optional(),
    /** What to keep, in the owner's words; Jarvis finds it by listening and looking («el gol de Paredes de penal», «todos los goles»). */
    find: z.string().trim().min(3).max(300).optional(),
    /** Exact parts to keep, in seconds from the start, when the owner gave the times. */
    segments: z
      .array(z.object({ start: z.number().min(0), end: z.number().positive() }))
      .min(1)
      .max(10)
      .optional(),
    /** Seconds kept before and after each moment found; 2 by default. */
    padding: z.number().min(0).max(30).optional(),
    /** Cropped to 9:16 for stories or reels. */
    vertical: z.boolean().optional(),
    /** «iphone» (default) keeps the video; «mp3» only the audio of the parts. */
    format: z.enum(["iphone", "mp3"]).optional(),
    /** Also keep the whole video in Transferencias. By default only the cut stays (a file already in Transferencias is kept). */
    keepSource: z.boolean().optional(),
    sendTo: SendFileTo.optional(),
  },
  transfer_convert: {
    transferId: z.uuid(),
    format: MediaFormat.exclude(["max"]),
    sendTo: SendFileTo.optional(),
  },
  transfer_send: {
    transferId: z.uuid(),
    ...SendFileTo.shape,
  },
  image_create: {
    prompt: z.string().trim().min(3).max(4000),
    /** Photos the owner uploaded, used as references to edit or build on. */
    attachmentIds: z.array(z.uuid()).max(4).optional(),
    quality: z.enum(["low", "medium", "high"]).optional(),
    format: z.enum(["square", "portrait", "landscape"]).optional(),
    /** A WhatsApp chat (id, number or name, or "me") that gets the image as soon as it is ready. */
    sendTo: z.object({ to: z.string().trim().min(1).max(120), text: z.string().trim().max(1000).optional() }).optional(),
  },
  page_list: {},
  page_responses: {
    slug: PageSlug,
    limit: z.number().int().min(1).max(100).optional(),
  },
} as const satisfies Record<string, z.ZodRawShape>;

export type ToolName = keyof typeof toolInputs;
export type ToolInput<T extends ToolName> = z.infer<z.ZodObject<(typeof toolInputs)[T]>>;

export const toolNames = Object.keys(toolInputs) as ToolName[];

/** Tools whose results contain third-party content (emails, chats, web pages, video titles). */
export const untrustedContentTools: ReadonlySet<ToolName> = new Set<ToolName>([
  "gmail_search",
  "gmail_get_thread",
  "whatsapp_search",
  "whatsapp_get_messages",
  "whatsapp_get_file",
  "whatsapp_study_result",
  "youtube_search",
  "task_status",
  "task_result",
  "page_responses",
  "drive_search",
  "drive_download",
  "drive_upload_status",
  "transfer_list",
  "transfer_suggest",
]);

/** Built-in Claude tools the runtime may expose. They are all treated as untrusted sources. */
export const builtinTools = ["WebSearch"] as const;
export type BuiltinTool = (typeof builtinTools)[number];

/**
 * Tools that change persistent state. After a turn has read untrusted content, these
 * require an explicit owner confirmation in the UI instead of executing directly.
 */
export const stateChangingTools: ReadonlySet<ToolName> = new Set<ToolName>([
  "memory_update",
  "memory_forget",
  "calendar_create",
  "calendar_update",
  "agreements_propose",
  "agreements_confirm",
  "agreements_cancel",
  "reminders_create",
  "reminders_update",
  "reminders_cancel",
  "task_create",
  "task_feedback",
  "task_control",
  "whatsapp_send",
  "whatsapp_voice_note",
  "page_create",
  "page_update",
  "gmail_send",
  "file_share_link",
  "video_create",
  "video_revise",
  "video_send",
  "video_page",
  "image_create",
  "drive_create_folder",
  "drive_upload",
  "drive_update",
  "drive_share",
  "drive_trash",
  "transfer_upload_link",
  "transfer_share_link",
  "transfer_from_link",
  "transfer_convert",
  "transfer_send",
  "transfer_edit",
]);

export const ToolErrorCode = z.enum([
  "not_connected",
  "auth_expired",
  "revoked",
  "rate_limited",
  "not_found",
  "invalid_input",
  "ambiguous",
  "needs_confirmation",
  "disabled",
  "upstream_error",
  "internal",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export interface ToolSource {
  /** e.g. "memory", "gmail", "whatsapp", "calendar", "youtube". */
  provider: string;
  /** Real account identifier when applicable, e.g. the Gmail address. Never a token. */
  account?: string;
}

export interface ToolPage {
  hasMore: boolean;
  nextCursor?: string;
}

/** What the data covers, so "not found" is never presented as "does not exist". */
export interface ToolCoverage {
  from?: string;
  to?: string;
  note?: string;
}

export interface ToolSuccess<T> {
  ok: true;
  source: ToolSource;
  fetchedAt: string;
  items: T[];
  page?: ToolPage;
  coverage?: ToolCoverage;
  /** Guidance for the model, e.g. "Do not claim the video is playing until confirmed". */
  note?: string;
}

export interface ToolFailure {
  ok: false;
  error: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
    /** Pending action id when code is needs_confirmation. */
    actionId?: string;
  };
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;
