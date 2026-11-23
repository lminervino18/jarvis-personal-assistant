const FILLER_WORDS = new Set(["aja", "ah", "ahm", "eh", "em", "ehm", "este", "mm", "mmm", "mhm", "hm", "hmm", "uh", "um", "oh"]);
const STOCK_PHRASES = [
  "amara org",
  "subtitulos realizados por",
  "subtitulos por la comunidad",
  "suscribete al canal",
  "gracias por ver el video",
  "gracias por ver",
  "nos vemos en el proximo video",
];
const MAX_STOCK_WORDS = 12;

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True for short stock phrases the recognizer invents from silence or noise (subtitle credits and the like). */
export function isStockPhrase(text: string): boolean {
  const folded = fold(text);
  if (!folded || folded.split(" ").length > MAX_STOCK_WORDS) return false;
  return STOCK_PHRASES.some((phrase) => ` ${folded} `.includes(` ${phrase} `));
}

/**
 * True when a transcript carries no request: silence, a stock phrase, or only sounds like "eh"
 * or "mmm". Words such as "sí" or "dale" always count, since they can answer a question.
 */
export function isFillerTranscript(text: string): boolean {
  const folded = fold(text);
  return !folded || isStockPhrase(text) || folded.split(" ").every((word) => FILLER_WORDS.has(word));
}

const BACKCHANNEL_WORDS = new Set([
  ...FILLER_WORDS,
  "si", "ok", "okay", "dale", "claro", "aha", "ajam", "uhum", "bien", "joya", "genial", "perfecto", "exacto", "ya", "obvio", "bueno", "listo", "re", "tal", "cual",
]);
const MAX_BACKCHANNEL_WORDS = 3;

/**
 * True for "ajá", "sí, claro", "dale" and the like said while the assistant talks: the owner is
 * listening, not taking the turn. Only applies to speech heard during playback.
 */
export function isBackchannel(text: string): boolean {
  const words = fold(text).split(" ").filter(Boolean);
  return words.length <= MAX_BACKCHANNEL_WORDS && words.every((word) => BACKCHANNEL_WORDS.has(word));
}
