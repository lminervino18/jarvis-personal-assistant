import type { AudioFormat } from "@jarvis/contracts";
import { pcmDurationMs } from "./pcm.js";
import type { SpeechEngine, SynthesisRequest } from "./reply-speaker.js";
import type { SpeechCapture, SpeechToTextService, TranscriptResult } from "./types.js";

export interface FixtureSttOptions {
  transcript: string | ((capturedBytes: number) => string);
  partials?: readonly string[];
  latencyMs?: number;
}

/** Deterministic speech-to-text for tests and offline development; it never hears anything. */
export class FixtureStt implements SpeechToTextService {
  readonly provider = "fixture";

  constructor(private readonly options: FixtureSttOptions) {}

  available(): boolean {
    return true;
  }

  startCapture(options: {
    turnId: string;
    format: AudioFormat;
    signal: AbortSignal;
    onPartial?: (text: string) => void;
  }): SpeechCapture {
    const { transcript, partials = [], latencyMs = 0 } = this.options;
    let bytes = 0;
    let pushes = 0;
    return {
      push: (pcm) => {
        bytes += pcm.byteLength;
        const partial = partials[pushes++];
        if (partial !== undefined) options.onPartial?.(partial);
      },
      finish: async (): Promise<TranscriptResult> => {
        const startedAt = performance.now();
        if (latencyMs > 0) await sleep(latencyMs, options.signal);
        if (options.signal.aborted) throw new Error("capture cancelled");
        const text = typeof transcript === "string" ? transcript : transcript(bytes);
        return { text, provider: "fixture", latencyMs: performance.now() - startedAt, audioMs: pcmDurationMs(bytes, options.format.sampleRate) };
      },
      cancel: () => {},
    };
  }
}

export interface FixtureEngineOptions {
  sampleRate?: number;
  msPerChar?: number;
  chunkMs?: number;
  chunkDelayMs?: number;
  firstChunkDelayMs?: number;
  failWhen?: (text: string) => boolean;
}

/** Deterministic text-to-speech that synthesizes a quiet tone per sentence. */
export class FixtureSpeechEngine implements SpeechEngine {
  readonly sampleRate: number;
  readonly spoken: string[] = [];

  constructor(private readonly options: FixtureEngineOptions = {}) {
    this.sampleRate = options.sampleRate ?? 22050;
  }

  async *synthesize(text: string, request: SynthesisRequest): AsyncIterable<Uint8Array> {
    const { msPerChar = 20, chunkMs = 100, chunkDelayMs = 0, firstChunkDelayMs = 0, failWhen } = this.options;
    this.spoken.push(text);
    if (failWhen?.(text)) throw new Error("fixture synthesis failure");
    const totalSamples = Math.round((text.length * msPerChar * this.sampleRate) / 1000);
    const chunkSamples = Math.max(1, Math.round((chunkMs * this.sampleRate) / 1000));
    const frequency = 200 + (text.charCodeAt(0) % 40) * 10;
    for (let start = 0; start < totalSamples; start += chunkSamples) {
      await sleep(start === 0 ? firstChunkDelayMs + chunkDelayMs : chunkDelayMs, request.signal);
      if (request.signal.aborted) throw new Error("synthesis aborted");
      const samples = new Int16Array(Math.min(chunkSamples, totalSamples - start));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.round(3000 * Math.sin((2 * Math.PI * frequency * (start + i)) / this.sampleRate));
      }
      yield new Uint8Array(samples.buffer);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
