import type { Card } from "@jarvis/contracts";

export type ConfirmCardView = Extract<Card, { kind: "confirm" }>;
export type SpokenDecision = "confirm" | "reject";

const MAX_WORDS = 5;
const MAX_DETAIL_CHARS = 280;
const FILLER = new Set(["jarvis", "por", "favor", "porfa", "che", "nomas", "ya", "ahi", "ahora"]);
const YES = new Set([
  "si", "sip", "dale", "ok", "okey", "okay", "claro", "obvio", "de", "una", "afirmativo", "correcto", "exacto", "metele",
  "confirmo", "confirma", "confirmalo", "confirmar", "confirmado", "confirmada", "hacelo", "adelante",
  "manda", "mandalo", "mandala", "mandale", "mandaselo", "mandasela", "mandar", "mandarlo",
  "envia", "envialo", "enviala", "enviaselo", "enviasela", "enviar", "enviarlo",
]);
const YES_SOFT = new Set(["listo", "bueno", "perfecto", "genial", "va", "esta", "bien", "eso", "asi"]);
const NO = new Set(["no", "nop", "nope", "nunca", "cancela", "cancelalo", "cancelar", "descarta", "descartalo", "descartar", "dejalo", "olvidalo"]);
const NO_SOFT = new Set(["mejor", "gracias", "lo", "la", "mandes", "envies", "todavia", "espera", "nada"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && !FILLER.has(word));
}

function decidedBy(said: string[], strong: ReadonlySet<string>, soft: ReadonlySet<string>): boolean {
  return said.every((word) => strong.has(word) || soft.has(word)) && said.some((word) => strong.has(word));
}

/**
 * Reads a short answer, spoken or typed, to a pending confirmation. Only a whole message made
 * of yes words (or of no words) counts, with at least one clear one ("listo" alone is not a yes);
 * anything longer or mixed is a normal turn.
 */
export function spokenDecision(text: string): SpokenDecision | undefined {
  const said = words(text);
  if (said.length === 0 || said.length > MAX_WORDS) return undefined;
  if (decidedBy(said, YES, YES_SOFT)) return "confirm";
  if (decidedBy(said, NO, NO_SOFT)) return "reject";
  return undefined;
}

const sentence = (text: string) => text.trim().replace(/[.!?…:;,\s]+$/u, "");
const clip = (text: string) => (text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS).trimEnd()}…` : text);

/** The question spoken after a reply that left a confirmation card, built from the card itself. */
export function confirmQuestion(card: ConfirmCardView): string {
  const parts = [card.title, card.summary, ...card.details.map((detail) => `${detail.label}: ${clip(detail.value)}`)].map(sentence).filter(Boolean);
  return `${parts.join(". ")}. ¿Confirmo?`;
}
