import { z } from "zod";
import { toZonedIso } from "../../util/time.js";
import { decodeEntities } from "../google/text.js";

export const MAX_BODY_CHARS = 4000;

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GmailMessageSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface GmailMessage extends GmailMessageSummary {
  body: string;
  bodyTruncated: boolean;
  attachments: GmailAttachment[];
}

interface RawPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string };
  parts?: RawPart[];
}

const RawPartSchema: z.ZodType<RawPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ size: z.number().optional(), data: z.string().optional() }).optional(),
    parts: z.array(RawPartSchema).optional(),
  }),
);

export const RawMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: RawPartSchema.optional(),
});
export type RawMessage = z.infer<typeof RawMessageSchema>;

export const RawThreadSchema = z.object({ id: z.string(), messages: z.array(RawMessageSchema).optional() });

export const RawListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;
const KEPT_CONTROLS = new Set(["\n", "\r", "\t"]);

const stripHidden = (text: string) => text.replace(HIDDEN_CHARS, (char) => (KEPT_CONTROLS.has(char) ? char : ""));

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function tidy(text: string): string {
  return stripHidden(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max).trimEnd()}…`, truncated: true };
}

function header(part: RawPart | undefined, name: string): string {
  const found = part?.headers?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  return tidy(found?.value ?? "");
}

function decodeBody(part: RawPart): string {
  return part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
}

function collectText(part: RawPart, found: { plain: string[]; html: string[] }): void {
  if (part.filename) return;
  if (part.mimeType === "text/plain") found.plain.push(decodeBody(part));
  if (part.mimeType === "text/html") found.html.push(decodeBody(part));
  for (const child of part.parts ?? []) collectText(child, found);
}

function collectAttachments(part: RawPart, found: GmailAttachment[]): void {
  if (part.filename) {
    found.push({
      filename: tidy(part.filename),
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, found);
}

export function extractBody(payload: RawPart | undefined, maxChars = MAX_BODY_CHARS): { body: string; truncated: boolean } {
  const found = { plain: [] as string[], html: [] as string[] };
  if (payload) collectText(payload, found);
  const raw = found.plain.length > 0 ? found.plain.join("\n") : found.html.map(htmlToText).join("\n");
  const { text, truncated } = truncateText(tidy(raw), maxChars);
  return { body: text, truncated };
}

export function toSummary(raw: RawMessage, timezone: string): GmailMessageSummary {
  const millis = Number(raw.internalDate);
  return {
    messageId: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload, "From"),
    to: header(raw.payload, "To"),
    subject: header(raw.payload, "Subject"),
    date: Number.isFinite(millis) && raw.internalDate ? toZonedIso(new Date(millis).toISOString(), timezone) : "",
    snippet: tidy(decodeEntities(raw.snippet ?? "")),
    labels: raw.labelIds ?? [],
  };
}

export function toMessage(raw: RawMessage, timezone: string): GmailMessage {
  const attachments: GmailAttachment[] = [];
  if (raw.payload) collectAttachments(raw.payload, attachments);
  const { body, truncated } = extractBody(raw.payload);
  return { ...toSummary(raw, timezone), body, bodyTruncated: truncated, attachments };
}
