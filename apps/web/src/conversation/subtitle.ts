import type { ThreadState } from "./thread.js";

export interface Subtitle {
  speaker: "owner" | "jarvis";
  text: string;
  /** The message also carries cards that only the chat shows. */
  cards: boolean;
}

const MAX_CHARS = 220;

function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/(\*\*|__|`+|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tail(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(text.length - MAX_CHARS);
  const space = cut.indexOf(" ");
  return `…${space > 0 && space < 30 ? cut.slice(space + 1) : cut}`;
}

/** What the voice screen shows under the core: the owner's live words, or the end of the latest message. */
export function voiceSubtitle(thread: ThreadState): Subtitle | null {
  if (thread.transcript?.text.trim()) return { speaker: "owner", text: tail(thread.transcript.text.trim()), cards: false };
  const last = thread.messages.findLast((message) => message.role !== "system");
  if (!last) return null;
  const text = tail(plain(last.text));
  if (!text && last.cards.length === 0) return null;
  return { speaker: last.role === "user" ? "owner" : "jarvis", text, cards: last.cards.length > 0 };
}
