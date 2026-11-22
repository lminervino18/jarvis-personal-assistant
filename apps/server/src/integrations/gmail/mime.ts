import { randomBytes } from "node:crypto";

export interface MailFile {
  name: string;
  mediaType: string;
  data: Buffer;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  files?: MailFile[];
}

const LINE = 76;

function headerSafe(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("header values cannot contain line breaks");
  return value;
}

function encodedWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function wrapped(base64: string): string {
  return base64.match(new RegExp(`.{1,${LINE}}`, "g"))?.join("\r\n") ?? "";
}

function textPart(body: string): string {
  return ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrapped(Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"))].join("\r\n");
}

function filePart(file: MailFile): string {
  const name = encodedWord(headerSafe(file.name.replace(/"/g, "'")));
  return [
    `Content-Type: ${headerSafe(file.mediaType)}; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapped(file.data.toString("base64")),
  ].join("\r\n");
}

/**
 * A UTF-8 message in RFC 2822 form, as Gmail's `messages.send` expects in `raw` (base64url):
 * plain text, or multipart/mixed when it carries files. Header values never carry line breaks,
 * so nothing can inject extra headers.
 */
export function buildRawMail(mail: OutgoingMail): string {
  const headers = [
    `From: ${headerSafe(mail.from)}`,
    `To: ${mail.to.map(headerSafe).join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map(headerSafe).join(", ")}`] : []),
    `Subject: ${encodedWord(headerSafe(mail.subject))}`,
    "MIME-Version: 1.0",
  ];
  if (!mail.files?.length) return Buffer.from(`${headers.join("\r\n")}\r\n${textPart(mail.body)}`, "utf8").toString("base64url");
  const boundary = `jarvis-${randomBytes(12).toString("hex")}`;
  const parts = [textPart(mail.body), ...mail.files.map(filePart)].map((part) => `--${boundary}\r\n${part}`);
  const message = `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--`;
  return Buffer.from(message, "utf8").toString("base64url");
}
