import { decodeWav } from "./pcm.js";
import type { SpeechEngine, SynthesisRequest } from "./reply-speaker.js";

const SLICE_MS = 100;

export interface PiperOptions {
  baseUrl: string;
  sampleRate?: number;
  lengthScale?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Talks to the Piper sidecar (`python -m piper.http_server`) over HTTP. The server returns
 * a complete WAV per sentence, so audio starts once the sentence is synthesized; sentence
 * chunking keeps that wait short. Piper itself is GPL-3.0 and only ever runs as that
 * separate process.
 */
export class PiperEngine implements SpeechEngine {
  readonly sampleRate: number;

  constructor(private readonly options: PiperOptions) {
    this.sampleRate = options.sampleRate ?? 22050;
  }

  async *synthesize(text: string, request: SynthesisRequest): AsyncIterable<Uint8Array> {
    const { baseUrl, lengthScale, timeoutMs = 15_000 } = this.options;
    const response = await (this.options.fetch ?? fetch)(`${baseUrl}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(lengthScale ? { length_scale: lengthScale } : {}) }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(`piper synthesis failed with status ${response.status}`);
    const wav = decodeWav(new Uint8Array(await response.arrayBuffer()));
    if (wav.sampleRate !== this.sampleRate) {
      throw new Error(`piper voice runs at ${wav.sampleRate} Hz but PIPER_SAMPLE_RATE is ${this.sampleRate}`);
    }
    const sliceBytes = Math.round((SLICE_MS * this.sampleRate) / 1000) * 2;
    for (let offset = 0; offset < wav.pcm.byteLength; offset += sliceBytes) {
      yield wav.pcm.subarray(offset, offset + sliceBytes);
    }
  }
}
