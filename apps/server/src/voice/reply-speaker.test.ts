import type { AudioFormat } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { EngineTextToSpeech } from "./engine-tts.js";
import { FixtureSpeechEngine, type FixtureEngineOptions } from "./fixture-providers.js";
import { concatBytes } from "./pcm.js";
import type { AudioSink } from "./types.js";

const FORMAT_22K: AudioFormat = { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 };
const FORMAT_16K: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

class RecordingSink implements AudioSink {
  readonly events: string[] = [];
  readonly frames: Uint8Array[] = [];
  processed: boolean | undefined;
  congested = false;
  private release: (() => void) | undefined;

  begin(_format: AudioFormat, processed: boolean): void {
    this.processed = processed;
    this.events.push("begin");
  }

  write(pcm: Uint8Array): boolean {
    this.frames.push(pcm.slice());
    this.events.push("write");
    return !this.congested;
  }

  waitForDrain(): Promise<void> {
    this.events.push("wait");
    return new Promise((resolve) => (this.release = resolve));
  }

  end(reason: "complete" | "cancelled" | "error"): void {
    this.events.push(`end:${reason}`);
  }

  drain(): void {
    this.congested = false;
    this.release?.();
  }

  get bytes(): Uint8Array {
    return concatBytes(this.frames);
  }
}

function setup(options: FixtureEngineOptions & { effect?: number; output?: AudioFormat; signal?: AbortSignal } = {}) {
  const engine = new FixtureSpeechEngine(options);
  const sink = new RecordingSink();
  const controller = new AbortController();
  const tts = new EngineTextToSpeech({ provider: "fixture", engine, effectIntensity: options.effect ?? 0 });
  const speaker = tts.createSpeaker({
    turnId: "turn-1",
    output: options.output ?? FORMAT_22K,
    sink,
    signal: options.signal ?? controller.signal,
  });
  return { engine, sink, speaker, controller };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("QueuedReplySpeaker", () => {
  it("speaks sanitized sentences in order and brackets them with one begin and one end", async () => {
    const { engine, sink, speaker } = setup();
    for (const delta of ["**Hola**", " Loren, buen día. ", "Tenés dos reuniones 🎉 hoy. ", "Mirá https://x.com/a"]) speaker.textDelta(delta);
    await speaker.finish();
    expect(engine.spoken).toEqual(["Hola Loren, buen día.", "Tenés dos reuniones hoy.", "Mirá el enlace"]);
    expect(sink.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(sink.events[0]).toBe("begin");
    expect(sink.events.at(-1)).toBe("end:complete");
    expect(speaker.firstAudioAt).toBeTypeOf("number");
  });

  it("sets firstAudioAt when the first chunk is written, not before", async () => {
    const { speaker } = setup({ firstChunkDelayMs: 30 });
    const startedAt = performance.now();
    speaker.textDelta("Hola Loren, ya estoy acá. ");
    await tick(5);
    expect(speaker.firstAudioAt).toBeUndefined();
    await speaker.finish();
    expect((speaker.firstAudioAt as number) - startedAt).toBeGreaterThanOrEqual(25);
  });

  it("drops unspoken provisional text when a tool starts but keeps what is already being spoken", async () => {
    const { engine, speaker } = setup({ chunkDelayMs: 20 });
    speaker.textDelta("Voy a revisar tu agenda ahora. Después te cuento todo lo demás. Y algo más sin terminar");
    await tick(5);
    speaker.toolStarted();
    speaker.textDelta("Listo, tenés dos eventos hoy.");
    await speaker.finish();
    expect(engine.spoken).toEqual(["Voy a revisar tu agenda ahora.", "Listo, tenés dos eventos hoy."]);
  });

  it("cancels immediately: ends the sink, aborts synthesis and writes nothing afterwards", async () => {
    const { engine, sink, speaker } = setup({ chunkDelayMs: 15, msPerChar: 60 });
    speaker.textDelta("Una frase bastante larga para que dure un rato. Y otra frase que nunca debería sonar. ");
    await tick(40);
    const written = sink.frames.length;
    expect(written).toBeGreaterThan(0);
    speaker.cancel();
    expect(sink.events.at(-1)).toBe("end:cancelled");
    await speaker.finish();
    await tick(40);
    expect(sink.frames).toHaveLength(written);
    expect(sink.events.filter((event) => event.startsWith("end"))).toEqual(["end:cancelled"]);
    expect(engine.spoken).toHaveLength(1);
  });

  it("does nothing audible when cancelled before any audio exists", async () => {
    const { sink, speaker } = setup({ firstChunkDelayMs: 50 });
    speaker.textDelta("Hola, esto no va a llegar a sonar. ");
    speaker.cancel();
    await speaker.finish();
    expect(sink.events).toEqual([]);
  });

  it("cancels when the turn signal aborts", async () => {
    const controller = new AbortController();
    const { sink, speaker } = setup({ chunkDelayMs: 10, msPerChar: 60, signal: controller.signal });
    speaker.textDelta("Una frase larga para que dure un buen rato. Y sigue");
    await tick(30);
    controller.abort();
    await speaker.finish();
    expect(sink.events.at(-1)).toBe("end:cancelled");
  });

  it("waits for drain when the sink is congested and resumes afterwards", async () => {
    const { sink, speaker } = setup({ msPerChar: 40 });
    sink.congested = true;
    speaker.textDelta("Una frase suficientemente larga para varios frames. ");
    const finished = speaker.finish();
    await tick(30);
    const writesWhileCongested = sink.frames.length;
    expect(writesWhileCongested).toBe(1);
    expect(sink.events.at(-1)).toBe("wait");
    sink.drain();
    await finished;
    expect(sink.frames.length).toBeGreaterThan(writesWhileCongested);
    expect(sink.events.at(-1)).toBe("end:complete");
  });

  it("rejects finish() when synthesis fails and tells the sink about the error", async () => {
    const { sink, speaker } = setup({ failWhen: (text) => text.includes("falla") });
    speaker.textDelta("Primero algo que anda bien. Ahora esto falla seguro. ");
    await expect(speaker.finish()).rejects.toThrow("fixture synthesis failure");
    expect(sink.events.at(-1)).toBe("end:error");
  });

  it("rejects finish() without touching the sink when the very first synthesis fails", async () => {
    const { sink, speaker } = setup({ failWhen: () => true });
    speaker.textDelta("Esto falla desde el principio.");
    await expect(speaker.finish()).rejects.toThrow();
    expect(sink.events).toEqual([]);
  });

  it("stays silent for replies without speakable text", async () => {
    const { sink, speaker } = setup();
    speaker.textDelta("🎉🎉");
    await speaker.finish();
    expect(sink.events).toEqual([]);
    expect(speaker.firstAudioAt).toBeUndefined();
  });

  it("resamples to the negotiated output rate", async () => {
    const { sink, speaker } = setup({ output: FORMAT_16K, msPerChar: 50 });
    const text = "Hola Loren, mañana tenés reunión.";
    speaker.textDelta(text);
    await speaker.finish();
    const expectedBytes = text.length * 0.05 * 16000 * 2;
    expect(Math.abs(sink.bytes.byteLength - expectedBytes)).toBeLessThan(16);
  });

  it("writes frames of bounded size", async () => {
    const { sink, speaker } = setup({ chunkMs: 1000, msPerChar: 200 });
    speaker.textDelta("Una frase corta pero lenta.");
    await speaker.finish();
    expect(sink.frames.length).toBeGreaterThan(1);
    expect(Math.max(...sink.frames.map((frame) => frame.byteLength))).toBeLessThanOrEqual(8192);
  });

  it("applies the robotic effect once and reports it, or leaves PCM untouched at intensity 0", async () => {
    const plain = setup({ effect: 0 });
    plain.speaker.textDelta("Hola Loren, buen día.");
    await plain.speaker.finish();
    const colored = setup({ effect: 0.4 });
    colored.speaker.textDelta("Hola Loren, buen día.");
    await colored.speaker.finish();
    expect(plain.sink.processed).toBe(false);
    expect(colored.sink.processed).toBe(true);
    expect(colored.sink.bytes.byteLength).toBe(plain.sink.bytes.byteLength);
    expect(colored.sink.bytes).not.toEqual(plain.sink.bytes);
  });
});

describe("EngineTextToSpeech", () => {
  const tts = new EngineTextToSpeech({ provider: "fixture", engine: new FixtureSpeechEngine({ sampleRate: 22050 }) });

  it("prefers the engine's native rate, then the closest rate without losing bandwidth", () => {
    expect(tts.chooseOutputFormat([FORMAT_16K, FORMAT_22K])).toEqual(FORMAT_22K);
    expect(tts.chooseOutputFormat([FORMAT_16K, { ...FORMAT_16K, sampleRate: 48000 }])).toEqual({ ...FORMAT_16K, sampleRate: 16000 });
    expect(tts.chooseOutputFormat([{ ...FORMAT_16K, sampleRate: 24000 }, FORMAT_16K])).toEqual({ ...FORMAT_16K, sampleRate: 24000 });
    expect(tts.chooseOutputFormat([])).toBeNull();
  });
});
