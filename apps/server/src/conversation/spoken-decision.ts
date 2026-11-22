import type { Card } from "@jarvis/contracts";

export type ConfirmCardView = Extract<Card, { kind: "confirm" }>;
export type SpokenDecision = "confirm" | "reject";

const MAX_WORDS = 5;
const MAX_DETAIL_CHARS = 280;
const FILLER = new Set(["jarvis", "por", "favor", "porfa", "che"]);
const YES = new Set([
  "si", "sip", "dale", "ok", "okey", "okay", "listo", "perfecto", "bueno", "claro", "obvio", "de", "una", "va",
  "confirmo", "confirma", "confirmalo", "confirmado", "manda", "mandalo", "mandale", "envia", "envialo", "hacelo", "adelante",
]);
const NO = new Set(["no", "nop", "nope", "cancela", "cancelalo", "descarta", "descartalo", "dejalo", "olvidalo", "mejor", "gracias"]);
const NO_CORE = new Set(["no", "nop", "nope", "cancela", "cancelalo", "descarta", "descartalo", "dejalo", "olvidalo"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !FILLER.has(word));
}

/**
 * Reads a short spoken answer to a pending confirmation. Only a whole utterance made of yes
 * words (or of no words) counts; anything longer or mixed is a normal turn.
 */
export function spokenDecision(text: string): SpokenDecision | undefined {
  const said = words(text);
  if (said.length === 0 || said.length > MAX_WORDS) return undefined;
  if (said.every((word) => YES.has(word))) return "confirm";
  if (said.every((word) => NO.has(word)) && said.some((word) => NO_CORE.has(word))) return "reject";
  return undefined;
}

const sentence = (text: string) => text.trim().replace(/[.!?…:;,\s]+$/u, "");
const clip = (text: string) => (text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS).trimEnd()}…` : text);

/** The question spoken after a reply that left a confirmation card, built from the card itself. */
export function confirmQuestion(card: ConfirmCardView): string {
  const parts = [card.title, card.summary, ...card.details.map((detail) => `${detail.label}: ${clip(detail.value)}`)].map(sentence).filter(Boolean);
  return `${parts.join(". ")}. ¿Confirmo?`;
}
