import type { AudioFormat } from "@jarvis/contracts";
import { concatBytes, encodeWav, pcmDurationMs, resample, toBytes, toSamples } from "./pcm.js";
import type { SpeechCapture, SpeechToTextService, TranscriptResult } from "./types.js";

const UPLOAD_SAMPLE_RATE = 16000;
const MIN_AUDIO_MS = 150;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenAiSttOptions {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * File-based transcription against an OpenAI-compatible `/audio/transcriptions` endpoint
 * (OpenAI, Groq, or a local faster-whisper server). The whole turn is uploaded as one WAV
 * when the client finishes speaking, so it never produces partial transcripts.
 */
export class OpenAiCompatibleStt implements SpeechToTextService {
  readonly provider: string;

  constructor(private readonly options: OpenAiSttOptions) {
    this.provider = options.provider;
  }

  available(): boolean {
    return true;
  }

  startCapture(options: { turnId: string; format: AudioFormat; signal: AbortSignal }): SpeechCapture {
    const chunks: Uint8Array[] = [];
    return {
      push: (pcm) => chunks.push(pcm.slice()),
      finish: () => this.transcribe(concatBytes(chunks), options.format, options.signal),
      cancel: () => {
        chunks.length = 0;
      },
    };
  }

  private async transcribe(pcm: Uint8Array, format: AudioFormat, signal: AbortSignal): Promise<TranscriptResult> {
    const audioMs = pcmDurationMs(pcm.byteLength, format.sampleRate);
    if (audioMs < MIN_AUDIO_MS) return { text: "", provider: this.provider, latencyMs: 0, audioMs };
    const startedAt = performance.now();
    const response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
      body: this.buildForm(pcm, format),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`${this.provider} transcription failed with status ${response.status}`);
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== "string") throw new Error(`${this.provider} returned no transcript`);
    return { text: body.text.trim(), provider: this.provider, latencyMs: performance.now() - startedAt, audioMs };
  }

  private buildForm(pcm: Uint8Array, format: AudioFormat): FormData {
    const upload = format.sampleRate > UPLOAD_SAMPLE_RATE ? toBytes(resample(toSamples(pcm), format.sampleRate, UPLOAD_SAMPLE_RATE)) : pcm;
    const rate = Math.min(format.sampleRate, UPLOAD_SAMPLE_RATE);
    const form = new FormData();
    form.set("file", new Blob([encodeWav(upload, rate)], { type: "audio/wav" }), "turn.wav");
    form.set("model", this.options.model);
    form.set("response_format", "json");
    form.set("temperature", "0");
    if (this.options.language) form.set("language", this.options.language);
    if (this.options.prompt) form.set("prompt", this.options.prompt);
    return form;
  }
}
