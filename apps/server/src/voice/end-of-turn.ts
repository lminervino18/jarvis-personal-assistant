const TRAILING_INCOMPLETE = new Set([
  "y", "e", "o", "u", "ni", "pero", "que", "porque", "como", "cuando", "donde", "si", "sino", "aunque", "mientras", "entonces",
  "de", "del", "a", "al", "en", "con", "para", "por", "sin", "sobre", "entre", "hasta", "desde", "hacia", "segun",
  "el", "la", "los", "las", "lo", "un", "una", "unos", "unas", "mi", "mis", "tu", "tus", "su", "sus", "nuestro", "nuestra",
  "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas", "aquel", "cual", "quien", "cuyo",
  "me", "te", "se", "le", "les", "nos",
  "eh", "em", "ehm", "mm", "mmm", "tipo", "osea", "digo", "perdon", "bueno",
  "quiero", "queria", "necesito", "podes", "podrias", "puedo", "tengo", "voy", "vamos", "hay", "es", "son", "esta", "estoy",
  "mas", "muy", "tambien", "tan",
]);
const TRAILING_PHRASES = ["o sea", "mejor dicho", "es decir", "no espera", "no espera que"];
const SHORT_ANSWERS = new Set(["si", "no", "dale", "ok", "okay", "listo", "gracias", "chau", "bueno", "claro", "perfecto", "joya", "genial", "obvio"]);

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a transcript at a pause sounds like a finished turn in Rioplatense Spanish. A trailing
 * connector ("quiero que…", "el de…"), an open ellipsis or comma, or a self-correction marker
 * ("perdón", "o sea") means the owner is probably still talking.
 */
export function turnLooksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/(\.\.\.|…|,|;|:|-)$/.test(trimmed)) return false;
  if (/[?!¿¡]$/.test(trimmed)) return true;
  const folded = fold(trimmed);
  if (!folded) return false;
  if (TRAILING_PHRASES.some((phrase) => folded === phrase || folded.endsWith(` ${phrase}`))) return false;
  const words = folded.split(" ");
  if (words.length <= 2 && words.every((word) => SHORT_ANSWERS.has(word))) return true;
  return !TRAILING_INCOMPLETE.has(words.at(-1) ?? "");
}
