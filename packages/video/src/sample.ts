import type { VideoScene } from "@jarvis/contracts";
import { buildTimeline, introNarration, type NarratedSegment, type VideoTimeline } from "./timeline.js";
import type { VideoFormat } from "@jarvis/contracts";

const MS_PER_CHARACTER = 62;

/** Evenly timed words for previews without audio; real videos use the TTS alignment instead. */
export function silentSegment(text: string): NarratedSegment {
  const words: NarratedSegment["words"] = [];
  let at = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const length = (word.length + 1) * MS_PER_CHARACTER;
    words.push({ text: word, startMs: at, endMs: at + length - 40 });
    at += length + (/[.!?]$/.test(word) ? 260 : 0);
  }
  return { text, file: "", durationMs: at, words };
}

export const SAMPLE_SCENES: VideoScene[] = [
  { type: "title", emoji: "🎬", kicker: "Nueva capacidad", title: "Videos que explican por vos", lead: "Guion, voz, animación y subtítulos en un solo pedido.", narration: "Ahora puedo armar videos cortos que explican una idea, con mi voz y subtítulos." },
  {
    type: "compare",
    title: "Mensaje largo o video",
    options: [
      { emoji: "📝", label: "Mensaje largo", points: ["Cuesta leerlo", "Se pierde el hilo"], highlight: false },
      { emoji: "🎥", label: "Video de 40 segundos", points: ["Se entiende de una", "Se ve sin sonido"], highlight: true },
    ],
    narration: "En vez de un mensaje largo, mandás un video de cuarenta segundos que se entiende de una.",
  },
  { type: "stat", emoji: "⏱️", value: 40, decimals: 0, suffix: " s", label: "dura un video típico", narration: "Un video típico dura unos cuarenta segundos." },
  {
    type: "steps",
    title: "Cómo se arma",
    steps: [{ emoji: "✍️", text: "Escribo el guion" }, { emoji: "🎙️", text: "Grabo la narración" }, { emoji: "✨", text: "Animo cada escena" }],
    narration: "Primero escribo el guion, después grabo la narración y al final animo cada escena.",
  },
  {
    type: "question",
    question: "¿Para qué lo usarías primero?",
    options: [{ emoji: "📣", label: "Un anuncio" }, { emoji: "🧠", label: "Explicar algo" }, { emoji: "✅", label: "Contar un resultado" }],
    replyHint: "Respondé a este mensaje con tu opción",
    narration: "¿Para qué lo usarías primero? ¿Un anuncio, explicar algo o contar un resultado?",
  },
  { type: "closing", emoji: "💬", title: "Pedímelo desde el chat", action: "Respondé a este mensaje", narration: "Pedímelo desde el chat y respondé a este mensaje con tu idea." },
];

export function sampleTimeline(format: VideoFormat = "vertical"): VideoTimeline {
  const intro = { type: "intro" as const, owner: "Loren", purpose: "mostrarte cómo puedo ayudarte a comunicar ideas con videos", narration: "" };
  intro.narration = introNarration(intro.owner, intro.purpose);
  const segments = [intro.narration, ...SAMPLE_SCENES.map((scene) => scene.narration)].map(silentSegment);
  return buildTimeline({ format, intro, scenes: SAMPLE_SCENES, segments, media: {} });
}
