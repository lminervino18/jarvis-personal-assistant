import type { VideoFormat, VideoScene } from "@jarvis/contracts";

export const FPS = 30;

export const SIZES: Record<VideoFormat, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

const LEAD_MS = 350;
const FIRST_LEAD_MS = 700;
const TAIL_MS = 450;
const LAST_TAIL_MS = 1600;
const CAPTION_CHARS: Record<VideoFormat, number> = { vertical: 30, landscape: 46 };
const CAPTION_HOLD_MS = 250;

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface IntroScene {
  type: "intro";
  narration: string;
  owner: string;
  purpose: string;
}

export type TimelineSceneContent = IntroScene | VideoScene;

/** A narrated stretch of audio: its file and the real start and end of every word, from the TTS alignment. */
export interface NarratedSegment {
  text: string;
  file: string;
  durationMs: number;
  words: TimedWord[];
}

export interface TimelineScene {
  content: TimelineSceneContent;
  startMs: number;
  durationMs: number;
  audio: { file: string; startMs: number; durationMs: number };
  /** Words relative to the scene start. */
  words: TimedWord[];
  /** When each of the scene's items appears, relative to the scene start. */
  cues: number[];
  media?: { file: string; kind: "image" | "video" };
}

export interface CaptionPage {
  text: string;
  startMs: number;
  endMs: number;
  words: TimedWord[];
}

/** Everything the composition needs to draw a video; computed once on the server, never per frame. */
export type VideoTimeline = {
  format: VideoFormat;
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  /** Prefix for asset files: a local URL while rendering, an owner-only API path in the app. */
  assetBase: string;
  scenes: TimelineScene[];
  captions: CaptionPage[];
};

export interface TimelineInput {
  format: VideoFormat;
  intro: IntroScene;
  scenes: VideoScene[];
  /** One per scene, the intro first. */
  segments: NarratedSegment[];
  media: Record<string, { file: string; kind: "image" | "video" }>;
}

export function introNarration(owner: string, purpose: string): string {
  const clean = purpose.trim().replace(/^para\s+/i, "").replace(/[.\s]+$/, "");
  return `Hola, soy Jarvis, el asistente personal de ${owner}. Este mensaje es para ${clean}.`;
}

function normalize(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Labels whose mention in the narration should make an item appear. */
export function sceneItems(content: TimelineSceneContent): string[] {
  switch (content.type) {
    case "intro":
      return ["mensaje"];
    case "compare":
      return content.options.map((option) => option.label);
    case "steps":
      return content.steps.map((step) => step.text);
    case "result":
      return content.facts.map((fact) => fact.label);
    case "question":
      return content.options.map((option) => option.label);
    case "closing":
      return [content.action];
    default:
      return [];
  }
}

/**
 * When each item appears: at the first spoken word that names it (in order), otherwise spread
 * over the first two thirds of the speech. Times are relative to the narration start.
 */
export function itemCues(items: readonly string[], words: readonly TimedWord[], speechMs: number): number[] {
  const spoken = words.map((word) => normalize(word.text));
  let from = 0;
  let previous = 0;
  return items.map((item, index) => {
    const keys = item.split(/\s+/).map(normalize).filter((key) => key.length >= 4);
    const found = keys.length ? spoken.findIndex((word, at) => at >= from && keys.includes(word)) : -1;
    if (found >= 0) from = found + 1;
    const spread = Math.round((speechMs * 0.66 * index) / Math.max(items.length, 1));
    previous = Math.max(previous, found >= 0 ? (words[found] as TimedWord).startMs : spread);
    return previous;
  });
}

function endsPhrase(word: string): boolean {
  return /[.!?;:]$/.test(word);
}

/** Groups words into short caption pages that never cross a pause or a sentence end. */
export function captionPages(words: readonly TimedWord[], maxChars: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let current: TimedWord[] = [];
  const flush = (nextStart?: number) => {
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) return;
    const hold = nextStart === undefined ? CAPTION_HOLD_MS : Math.min(CAPTION_HOLD_MS, Math.max(0, nextStart - last.endMs));
    pages.push({ text: current.map((word) => word.text).join(" "), startMs: first.startMs, endMs: last.endMs + hold, words: current });
    current = [];
  };
  for (const [index, word] of words.entries()) {
    const length = current.reduce((total, item) => total + item.text.length + 1, 0);
    if (current.length && length + word.text.length > maxChars) flush(word.startMs);
    current.push(word);
    const next = words[index + 1];
    const comma = /,$/.test(word.text) && length >= maxChars / 2;
    if (endsPhrase(word.text) || comma || (next && next.startMs - word.endMs > 450)) flush(next?.startMs);
  }
  flush();
  return pages;
}

/** Lays the scenes over their narration: each starts a moment before its audio and holds a moment after. */
export function buildTimeline(input: TimelineInput, assetBase = ""): VideoTimeline {
  const contents: TimelineSceneContent[] = [input.intro, ...input.scenes];
  if (input.segments.length !== contents.length) throw new Error("every scene needs its narration");
  const scenes: TimelineScene[] = [];
  const captions: CaptionPage[] = [];
  let startMs = 0;
  for (const [index, content] of contents.entries()) {
    const segment = input.segments[index] as NarratedSegment;
    const lead = index === 0 ? FIRST_LEAD_MS : LEAD_MS;
    const tail = index === contents.length - 1 ? LAST_TAIL_MS : TAIL_MS;
    const durationMs = lead + segment.durationMs + tail;
    const words = segment.words.map((word) => ({ ...word, startMs: word.startMs + lead, endMs: word.endMs + lead }));
    const cues = itemCues(sceneItems(content), segment.words, segment.durationMs).map((cue) => cue + lead);
    const media = content.type === "media" ? input.media[content.attachmentId] : undefined;
    scenes.push({ content, startMs, durationMs, audio: { file: segment.file, startMs: lead, durationMs: segment.durationMs }, words, cues, ...(media ? { media } : {}) });
    const global = words.map((word) => ({ ...word, startMs: word.startMs + startMs, endMs: word.endMs + startMs }));
    captions.push(...captionPages(global, CAPTION_CHARS[input.format]));
    startMs += durationMs;
  }
  const { width, height } = SIZES[input.format];
  return { format: input.format, fps: FPS, width, height, durationMs: startMs, assetBase, scenes, captions };
}

function stamp(ms: number, separator: string): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

export function toSrt(pages: readonly CaptionPage[]): string {
  return pages.map((page, index) => `${index + 1}\n${stamp(page.startMs, ",")} --> ${stamp(page.endMs, ",")}\n${page.text}\n`).join("\n");
}

export function toVtt(pages: readonly CaptionPage[]): string {
  return `WEBVTT\n\n${pages.map((page) => `${stamp(page.startMs, ".")} --> ${stamp(page.endMs, ".")}\n${page.text}\n`).join("\n")}`;
}

/** Groups character timings from the TTS into words, keeping the punctuation attached to each word. */
export function wordsFromCharacters(characters: readonly string[], starts: readonly number[], ends: readonly number[]): TimedWord[] {
  const words: TimedWord[] = [];
  let text = "";
  let startMs = 0;
  let endMs = 0;
  const flush = () => {
    if (text.trim()) words.push({ text: text.trim(), startMs, endMs });
    text = "";
  };
  for (const [index, character] of characters.entries()) {
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (!text) startMs = Math.round((starts[index] ?? 0) * 1000);
    text += character;
    endMs = Math.round((ends[index] ?? 0) * 1000);
  }
  flush();
  return words;
}
