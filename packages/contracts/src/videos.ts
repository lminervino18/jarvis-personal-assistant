import { z } from "zod";

const Line = (max: number) => z.string().trim().min(1).max(max);
const Emoji = z.string().trim().min(1).max(16).describe("Un emoji, por ejemplo 📈");
const Narration = z
  .string()
  .trim()
  .min(1)
  .max(450)
  .describe("Lo que dice Jarvis durante esta escena: 1 a 3 oraciones cortas en español rioplatense, que nombren lo que se ve");

/** Total narration a video may carry, intro aside (about two and a half minutes of speech). */
export const MAX_VIDEO_NARRATION_CHARS = 2400;

export const VideoFormat = z.enum(["vertical", "landscape"]);
export type VideoFormat = z.infer<typeof VideoFormat>;

export const VideoStatus = z.enum(["queued", "voice", "render", "verify", "ready", "failed", "cancelled"]);
export type VideoStatus = z.infer<typeof VideoStatus>;

export const VideoScene = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("title"),
    narration: Narration,
    emoji: Emoji.optional(),
    kicker: Line(40).optional(),
    title: Line(70),
    lead: Line(160).optional(),
  }),
  z.object({
    type: z.literal("media"),
    narration: Narration,
    attachmentId: z.uuid().describe("Foto o video que el dueño adjuntó o que bajaste de WhatsApp"),
    title: Line(60).optional(),
    text: Line(140).optional(),
    focus: z.enum(["center", "top", "bottom"]).default("center"),
  }),
  z.object({
    type: z.literal("compare"),
    narration: Narration,
    title: Line(60),
    options: z
      .array(
        z.object({
          emoji: Emoji.optional(),
          label: Line(32),
          points: z.array(Line(60)).max(3).default([]),
          highlight: z.boolean().default(false),
        }),
      )
      .min(2)
      .max(3),
  }),
  z.object({
    type: z.literal("stat"),
    narration: Narration,
    emoji: Emoji.optional(),
    value: z.number().finite(),
    decimals: z.number().int().min(0).max(2).default(0),
    prefix: z.string().max(4).optional(),
    suffix: z.string().max(8).optional(),
    label: Line(80),
    context: Line(120).optional(),
  }),
  z.object({
    type: z.literal("steps"),
    narration: Narration,
    title: Line(60),
    steps: z
      .array(z.object({ emoji: Emoji.optional(), text: Line(70) }))
      .min(2)
      .max(5),
  }),
  z.object({
    type: z.literal("result"),
    narration: Narration,
    outcome: z.enum(["done", "partial", "failed"]),
    title: Line(60),
    facts: z
      .array(z.object({ label: Line(24), value: Line(48) }))
      .max(4)
      .default([]),
  }),
  z.object({
    type: z.literal("question"),
    narration: Narration,
    question: Line(90),
    options: z
      .array(z.object({ emoji: Emoji.optional(), label: Line(36) }))
      .min(2)
      .max(4),
    replyHint: Line(60).default("Respondé a este mensaje con tu opción"),
  }),
  z.object({
    type: z.literal("closing"),
    narration: Narration,
    emoji: Emoji.optional(),
    title: Line(60),
    action: Line(60).describe("Qué tiene que hacer quien lo ve, como instrucción: «Respondé a este mensaje», «Abrí el link»"),
    link: z.string().trim().max(80).optional().describe("Texto corto de un link para mostrar, sin https://"),
  }),
]);
export type VideoScene = z.infer<typeof VideoScene>;

/**
 * What the assistant writes to make a video: who it is for, why, the confirmed facts and the
 * scenes with their narration. The spoken intro («Hola, soy Jarvis, el asistente personal de …
 * Este mensaje es para {purpose}») is always added by the server.
 */
export const VideoBrief = z
  .object({
    title: Line(80).describe("Nombre interno del video"),
    audience: Line(120).describe("Para quién es"),
    goal: z.enum(["explain", "announce", "ask", "result", "other"]),
    message: Line(240).describe("El mensaje principal en una oración"),
    facts: z.array(Line(200)).max(10).default([]).describe("Datos confirmados que usa el video; nada inventado"),
    format: VideoFormat.default("vertical"),
    purpose: Line(140).describe("Completa «Este mensaje es para …», por ejemplo «explicarte las opciones que estuvimos viendo»"),
    scenes: z.array(VideoScene).min(1).max(10),
    links: z
      .array(z.object({ label: Line(40), url: z.url().max(500) }))
      .max(3)
      .default([])
      .describe("Fuentes o más información, para la versión web"),
  })
  .refine((brief) => brief.scenes.reduce((total, scene) => total + scene.narration.length, 0) <= MAX_VIDEO_NARRATION_CHARS, {
    message: `La narración de todas las escenas suma más de ${MAX_VIDEO_NARRATION_CHARS} caracteres; acortala`,
    path: ["scenes"],
  });
export type VideoBrief = z.infer<typeof VideoBrief>;

export const VideoFile = z.object({ attachmentId: z.uuid(), size: z.number().int().nonnegative() });
export type VideoFile = z.infer<typeof VideoFile>;
