import { z } from "zod";
import { ChartShape, TableShape } from "./cards.js";

const isoDateTimeWithOffset = z.iso.datetime({ offset: true });
const IsoWithOffset = z
  .string()
  .refine((value) => isoDateTimeWithOffset.safeParse(value).success, "Fecha ISO 8601 con offset inválida")
  .describe("ISO 8601 con offset");
const EntityId = z.string().min(1).max(64);
const TaskRef = z.number().int().positive();
export const ProjectSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const MemoryCategory = z.enum(["preference", "fact", "person", "routine", "work", "other"]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const GmailAccountLabel = z.enum(["personal", "work"]);
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
  "youtube_search",
  "task_status",
  "task_result",
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
]);

/** State-changing tools that always wait for the owner's tap on a confirmation card, tainted turn or not. */
export const confirmAlwaysTools: ReadonlySet<ToolName> = new Set<ToolName>(["whatsapp_send"]);

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
