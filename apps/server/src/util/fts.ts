const STOPWORDS = new Set(
  (
    "de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta " +
    "entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros " +
    "ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada " +
    "muchos cual poco ella estar estas algunas algo nosotros mis tu te ti tus ellas sobre dijo dice"
  ).split(" "),
);

function normalize(token: string): string {
  return token.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Turns free text into a safe FTS5 MATCH expression: quoted prefix terms joined by OR,
 * so user input can never inject FTS operators. Returns null when nothing searchable remains.
 */
export function toFtsQuery(text: string, maxTerms = 8): string | null {
  const tokens = (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalize)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const unique = [...new Set(tokens)].slice(0, maxTerms);
  if (unique.length === 0) return null;
  return unique.map((token) => `"${token}"*`).join(" OR ");
}
