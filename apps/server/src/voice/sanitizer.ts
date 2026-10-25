const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?'"]/gi;
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}/gu;
const JARVIS_PATTERN = /\bJ\.?A\.?R\.?V\.?I\.?S\b/gi;

/**
 * Turns one chunk of assistant markdown into text that sounds natural when read aloud.
 * Returns an empty string when nothing speakable remains.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(URL_PATTERN, "el enlace")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/^\s*\|\s*|\s*\|\s*$/gm, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/(\*{1,3}|_{1,3}|~~)(?=\S)([^*_~\n]*?)(?<=\S)\1/g, "$2")
    .replace(/[*_~#`]+/g, "")
    .replace(EMOJI_PATTERN, "")
    .replace(JARVIS_PATTERN, "Jarvis")
    .replace(/\s*(?:->|→|=>)\s*/g, ", ")
    .replace(/(\d)\s*%/g, "$1 por ciento")
    .replace(/\s&\s/g, " y ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/([.!?…])(?:\s*\.)+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:]+/, "")
    .trim();
}
