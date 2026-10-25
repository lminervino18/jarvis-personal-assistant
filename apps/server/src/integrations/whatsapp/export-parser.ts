import { DateTime } from "luxon";

export type DateOrder = "dmy" | "mdy";
export type ExportMessageKind = "text" | "media" | "system";

export interface ParsedMessage {
  tsUtc: string;
  sender: string | null;
  text: string;
  kind: ExportMessageKind;
  edited: boolean;
  deleted: boolean;
}

export interface ParsedExport {
  messages: ParsedMessage[];
  dateOrder: DateOrder;
  unparsedLines: number;
}

export interface ParseOptions {
  timezone: string;
  dateOrder?: DateOrder;
}

interface RawEntry {
  parts: string[];
  lines: string[];
}

const DATE_TIME = String.raw`(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]\.?\s?m\.?))?`;
const IOS_HEADER = new RegExp(String.raw`^\[${DATE_TIME}\]\s*(.*)$`, "i");
const ANDROID_HEADER = new RegExp(String.raw`^${DATE_TIME}\s+-\s+(.*)$`, "i");

const SYSTEM_SENDER =
  /\b(cre[óo]|cambi[óo]|cambiaste|a[ñn]adi[óo]|a[ñn]adiste|agreg[óo]|elimin[óo]|quit[óo]|sali[óo]|saliste|se uni[óo]|fuiste|created|changed|added|removed|left|joined|you were)\b/i;
const MEDIA_ONLY: RegExp[] = [
  /^<(multimedia|archivo|media)\s+omitid[oa]>$/i,
  /^<media omitted>$/i,
  /^(imagen|video|audio|sticker|gif|documento|contacto|tarjeta de contacto|ubicaci[óo]n)(\s+de\s+.+)?\s+omitid[oa]$/i,
  /^(image|video|audio|sticker|gif|document|contact card|location)\s+omitted$/i,
];
const ATTACHED_LINE = /^(?:<(?:adjunto|attached):\s*[^>]*>|.*\((?:archivo adjunto|file attached)\))$/i;
const DELETED_MESSAGE =
  /^(se elimin[óo] este mensaje|eliminaste este mensaje|este mensaje fue eliminado|you deleted this message|this message was deleted)\.?$/i;
const EDITED_SUFFIX = /\s*<(?:se edit[óo] este mensaje|this message was edited)\.?>\s*$/i;
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPACES = /[\u00a0\u202f]/g;
const ENGLISH_MERIDIEM = /^[ap]m$/i;

export const normalizeLine = (line: string) => line.replace(INVISIBLE, "").replace(SPACES, " ").replace(/\r$/, "");

function splitHeader(line: string): { parts: string[]; rest: string } | undefined {
  const match = IOS_HEADER.exec(line) ?? ANDROID_HEADER.exec(line);
  if (!match) return undefined;
  return { parts: match.slice(1, 8).map((part) => part ?? ""), rest: match[8] ?? "" };
}

function groupEntries(lines: string[]): { entries: RawEntry[]; unparsedLines: number } {
  const entries: RawEntry[] = [];
  let unparsedLines = 0;
  for (const line of lines) {
    const header = splitHeader(line);
    if (header) entries.push({ parts: header.parts, lines: [header.rest] });
    else if (entries.length > 0) entries.at(-1)?.lines.push(line);
    else if (line.trim() !== "") unparsedLines++;
  }
  return { entries, unparsedLines };
}

export function detectDateOrder(entries: { parts: string[] }[], preference?: DateOrder): DateOrder {
  const firsts = entries.map((entry) => Number(entry.parts[0]));
  const seconds = entries.map((entry) => Number(entry.parts[1]));
  const dmyPossible = seconds.every((value) => value <= 12);
  const mdyPossible = firsts.every((value) => value <= 12);
  if (dmyPossible && mdyPossible) return preference ?? (entries.some((entry) => ENGLISH_MERIDIEM.test(entry.parts[6] ?? "")) ? "mdy" : "dmy");
  return dmyPossible ? "dmy" : "mdy";
}

function toUtcIso(parts: string[], order: DateOrder, timezone: string): string | undefined {
  const [first, second, rawYear, rawHour, minute, second2, meridiem] = parts;
  const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear);
  let hour = Number(rawHour);
  if (meridiem) hour = (hour % 12) + (meridiem.toLowerCase().startsWith("p") ? 12 : 0);
  const [day, month] = order === "dmy" ? [Number(first), Number(second)] : [Number(second), Number(first)];
  const local = DateTime.fromObject({ year, month, day, hour, minute: Number(minute), second: Number(second2 || 0) }, { zone: timezone });
  return local.isValid ? (local.toUTC().toISO() ?? undefined) : undefined;
}

function classify(text: string): Pick<ParsedMessage, "text" | "kind" | "edited" | "deleted"> {
  const edited = EDITED_SUFFIX.test(text);
  const clean = text.replace(EDITED_SUFFIX, "").trim();
  if (DELETED_MESSAGE.test(clean)) return { text: "", kind: "text", edited: false, deleted: true };
  if (MEDIA_ONLY.some((pattern) => pattern.test(clean))) return { text: "", kind: "media", edited, deleted: false };
  const [first = "", ...caption] = clean.split("\n");
  if (ATTACHED_LINE.test(first.trim())) return { text: caption.join("\n").trim(), kind: "media", edited, deleted: false };
  return { text: clean, kind: "text", edited, deleted: false };
}

function toMessage(entry: RawEntry, tsUtc: string): ParsedMessage {
  const [first = "", ...continuation] = entry.lines;
  const separator = first.indexOf(": ");
  const sender = separator > 0 ? first.slice(0, separator).trim() : "";
  if (!sender || SYSTEM_SENDER.test(sender)) {
    return { tsUtc, sender: null, text: entry.lines.join("\n").trim(), kind: "system", edited: false, deleted: false };
  }
  const body = [first.slice(separator + 2), ...continuation].join("\n");
  return { tsUtc, sender, ...classify(body) };
}

/**
 * Parses a WhatsApp "Export chat" text file (Android or iOS, Spanish or English). Timestamps are read
 * in the given time zone. Dates are day-first unless the file proves month-first or `dateOrder` says so.
 */
export function parseExport(text: string, options: ParseOptions): ParsedExport {
  const { entries, unparsedLines } = groupEntries(text.split("\n").map(normalizeLine));
  const dateOrder = detectDateOrder(entries, options.dateOrder);
  const messages: ParsedMessage[] = [];
  let invalid = 0;
  for (const entry of entries) {
    const tsUtc = toUtcIso(entry.parts, dateOrder, options.timezone);
    if (tsUtc) messages.push(toMessage(entry, tsUtc));
    else invalid++;
  }
  return { messages, dateOrder, unparsedLines: unparsedLines + invalid };
}
