import type { VideoBrief, VideoScene } from "@jarvis/contracts";

const STOPWORDS = new Set([
  "como", "para", "pero", "porque", "este", "esta", "esto", "estos", "estas", "todo", "todos", "toda", "todas", "cuando", "donde", "sobre",
  "desde", "hasta", "entre", "tambien", "ahora", "solo", "cada", "otro", "otra", "otros", "otras", "ellos", "ellas", "nosotros", "ustedes",
  "mensaje", "jarvis", "hola", "parte", "quiero", "queres", "hacer", "estar", "tener", "decir",
]);

function contentWords(text: string, ignore: readonly string[]): string[] {
  const skip = new Set(ignore.map((word) => normalize(word)));
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalize)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !skip.has(word));
}

function normalize(word: string): string {
  return word.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function headline(scene: VideoScene): string {
  switch (scene.type) {
    case "question":
      return scene.question;
    case "stat":
      return scene.label;
    default:
      return scene.title ?? "";
  }
}

function repeats(text: string, known: ReadonlySet<string>, owner: string): boolean {
  const words = contentWords(text, [owner]);
  if (words.length === 0) return false;
  const matched = words.filter((word) => known.has(word)).length;
  return (matched / words.length >= 0.6 && matched >= 2) || (words.length <= 2 && matched === words.length);
}

/**
 * Finds a scene that only says again what the spoken intro («Este mensaje es para …») or an
 * earlier scene already said. Each scene must add something new; a repeat makes videos feel padded.
 */
export function repetitionProblem(brief: VideoBrief, owner: string): string | undefined {
  const purpose = new Set(contentWords(brief.purpose, [owner]));
  const said: { index: number; words: Set<string> }[] = [];
  for (const [index, scene] of brief.scenes.entries()) {
    if (repeats(scene.narration, purpose, owner) || repeats(headline(scene), purpose, owner)) {
      return `La escena ${index + 1} repite lo que ya dice la presentación («Este mensaje es para ${brief.purpose}»). Cada escena tiene que sumar algo nuevo (un dato, las opciones, qué hacer); si no hay nada más que decir, dejá el propósito como tema general y usá una sola escena con lo concreto.`;
    }
    const earlier = said.find((item) => repeats(scene.narration, item.words, owner));
    if (earlier) return `La escena ${index + 1} repite lo que dice la escena ${earlier.index + 1}. Sacala o hacé que diga algo nuevo.`;
    said.push({ index, words: new Set(contentWords(scene.narration, [owner])) });
  }
  return undefined;
}
