export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
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

/**
 * A plain-text UTF-8 message in RFC 2822 form, as Gmail's `messages.send` expects in `raw`
 * (base64url). Header values never carry line breaks, so nothing can inject extra headers.
 */
export function buildRawMail(mail: OutgoingMail): string {
  const headers = [
    `From: ${headerSafe(mail.from)}`,
    `To: ${mail.to.map(headerSafe).join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.map(headerSafe).join(", ")}`] : []),
    `Subject: ${encodedWord(headerSafe(mail.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrapped(Buffer.from(mail.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"));
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}
