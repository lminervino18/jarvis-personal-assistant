import type { SpeechEngine, SynthesisRequest } from "./reply-speaker.js";

const PCM_RATES = [16000, 22050, 24000, 44100] as const;

export type ElevenLabsRate = (typeof PCM_RATES)[number];

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  sampleRate?: ElevenLabsRate;
  languageCode?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function isElevenLabsRate(rate: number): rate is ElevenLabsRate {
  return (PCM_RATES as readonly number[]).includes(rate);
}

/**
 * Streams raw PCM from the ElevenLabs text-to-speech endpoint, one request per sentence.
 * Node's fetch keeps the TLS connection pooled between sentences; previous_text keeps the
 * prosody continuous across requests.
 */
export class ElevenLabsEngine implements SpeechEngine {
  readonly sampleRate: ElevenLabsRate;
  private readonly model: string;

  constructor(private readonly options: ElevenLabsOptions) {
    this.sampleRate = options.sampleRate ?? 24000;
    this.model = options.model ?? "eleven_flash_v2_5";
  }

  async *synthesize(text: string, request: SynthesisRequest): AsyncIterable<Uint8Array> {
    const { apiKey, voiceId, languageCode, baseUrl = "https://api.elevenlabs.io", timeoutMs = 30_000 } = this.options;
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${this.sampleRate}`;
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: this.model,
        ...(languageCode ? { language_code: languageCode } : {}),
        ...(request.previousText ? { previous_text: request.previousText } : {}),
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok || !response.body) throw new Error(`elevenlabs synthesis failed with status ${response.status}`);
    for await (const chunk of response.body) yield chunk;
  }
}
