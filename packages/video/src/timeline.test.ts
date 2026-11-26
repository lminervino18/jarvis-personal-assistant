import { describe, expect, it } from "vitest";
import { SAMPLE_SCENES, sampleTimeline, silentSegment } from "./sample.js";
import { buildTimeline, captionPages, introNarration, itemCues, toSrt, toVtt, wordsFromCharacters } from "./timeline.js";

describe("video timeline", () => {
  it("always opens with the spoken intro, whatever the purpose looks like", () => {
    expect(introNarration("Loren", "para invitarte al torneo.")).toBe("Hola, soy Jarvis, el asistente personal de Loren. Este mensaje es para invitarte al torneo.");
    expect(introNarration("Loren", "para invitarte al torneo.", false)).toBe("Este mensaje es para invitarte al torneo.");
  });

  it("groups the TTS character timings into words with their real times", () => {
    const characters = [..."Hola, soy Jarvis."];
    const starts = characters.map((_, index) => index * 0.05);
    const ends = characters.map((_, index) => index * 0.05 + 0.04);
    expect(wordsFromCharacters(characters, starts, ends)).toEqual([
      { text: "Hola,", startMs: 0, endMs: 240 },
      { text: "soy", startMs: 300, endMs: 440 },
      { text: "Jarvis.", startMs: 500, endMs: 840 },
    ]);
  });

  it("shows each item when the narration names it, in order, and spreads the ones it never names", () => {
    const words = [
      { text: "Primero", startMs: 0, endMs: 300 },
      { text: "escribo", startMs: 400, endMs: 700 },
      { text: "el", startMs: 750, endMs: 800 },
      { text: "guion,", startMs: 850, endMs: 1200 },
      { text: "después", startMs: 1300, endMs: 1700 },
      { text: "grabo", startMs: 1800, endMs: 2100 },
    ];
    expect(itemCues(["Escribo el guion", "Grabo la narración", "Animo"], words, 3000)).toEqual([400, 1800, 1800]);
  });

  it("cuts captions at sentence ends and pauses, never past the character budget", () => {
    const pages = captionPages(silentSegment("Hola, soy Jarvis. Este mensaje es para mostrarte cómo puedo ayudarte con videos.").words, 30);
    expect(pages.map((page) => page.text)).toEqual(["Hola, soy Jarvis.", "Este mensaje es para mostrarte", "cómo puedo ayudarte con", "videos."]);
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(30);
    expect(pages.every((page, index) => index === 0 || page.startMs >= (pages[index - 1]?.endMs ?? 0))).toBe(true);
  });

  it("lays scenes one after another over their narration, with words and captions on the global clock", () => {
    const timeline = sampleTimeline();
    expect(timeline).toMatchObject({ format: "vertical", width: 1080, height: 1920, fps: 30 });
    expect(timeline.scenes.map((scene) => scene.content.type)).toEqual(["intro", ...SAMPLE_SCENES.map((scene) => scene.type)]);
    for (const [index, scene] of timeline.scenes.entries()) {
      const previous = timeline.scenes[index - 1];
      expect(scene.startMs).toBe(previous ? previous.startMs + previous.durationMs : 0);
      expect(scene.audio.startMs + scene.audio.durationMs).toBeLessThan(scene.durationMs);
    }
    const last = timeline.scenes.at(-1)!;
    expect(timeline.durationMs).toBe(last.startMs + last.durationMs);
    expect(timeline.captions[0]?.text).toBe("Hola, soy Jarvis, el asistente");
    expect(timeline.captions[0]?.startMs).toBe(400);
  });

  it("refuses a timeline whose scenes miss their narration", () => {
    expect(() => buildTimeline({ format: "vertical", intro: { type: "intro", owner: "Loren", purpose: "x", narration: "x", introduce: true }, scenes: SAMPLE_SCENES, segments: [], media: {} })).toThrow();
  });

  it("writes SRT and WebVTT subtitles from the same captions", () => {
    const pages = [{ text: "Hola, soy Jarvis.", startMs: 700, endMs: 1950, words: [] }];
    expect(toSrt(pages)).toBe("1\n00:00:00,700 --> 00:00:01,950\nHola, soy Jarvis.\n");
    expect(toVtt(pages)).toBe("WEBVTT\n\n00:00:00.700 --> 00:00:01.950\nHola, soy Jarvis.\n");
  });
});
