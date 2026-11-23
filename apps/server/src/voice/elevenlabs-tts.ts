import WebSocket from "ws";
import type { SpeechStream, StreamingSpeechEngine, SynthesisRequest } from "./reply-speaker.js";

const PCM_RATES = [16000, 22050, 24000, 44100] as const;

export type ElevenLabsRate = (typeof PCM_RATES)[number];

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  sampleRate?: ElevenLabsRate;
  languageCode?: string;
  baseUrl?: string;
  /** Origin of the WebSocket input endpoint (wss://…). */
  socketUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Seconds a reply's socket may stay idle (tools can run long before the first sentence). */
const SOCKET_INACTIVITY_SECONDS = 120;

/** Audio chunks handed from socket events to an async iterator, ending once or failing once. */
class AudioQueue {
  private readonly chunks: Uint8Array[] = [];
  private waiting: (() => void) | undefined;
  private done = false;
  private failure: Error | undefined;

  push(chunk: Uint8Array): void {
    if (this.done) return;
    this.chunks.push(chunk);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.done) return;
    this.failure = error;
    this.end();
  }

  async *iterate(): AsyncIterable<Uint8Array> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

export function isElevenLabsRate(rate: number): rate is ElevenLabsRate {
  return (PCM_RATES as readonly number[]).includes(rate);
}

/**
 * ElevenLabs text-to-speech as raw PCM. A reply uses one WebSocket to the stream-input endpoint,
 * opened before the first sentence exists so the handshake is off the critical path, with one
 * flushed message per sentence. The HTTP stream endpoint (one request per sentence, previous_text
 * for prosody) remains for fallback.
 */
export class ElevenLabsEngine implements StreamingSpeechEngine {
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

  openStream(signal: AbortSignal): SpeechStream {
    const { apiKey, voiceId, languageCode, socketUrl = "wss://api.elevenlabs.io" } = this.options;
    const query = new URLSearchParams({
      model_id: this.model,
      output_format: `pcm_${this.sampleRate}`,
      inactivity_timeout: String(SOCKET_INACTIVITY_SECONDS),
      ...(languageCode ? { language_code: languageCode } : {}),
    });
    const socket = new WebSocket(`${socketUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`, { headers: { "xi-api-key": apiKey } });
    const audio = new AudioQueue();
    const pending = [JSON.stringify({ text: " " })];
    const deliver = () => {
      if (socket.readyState === WebSocket.OPEN) for (const message of pending.splice(0)) socket.send(message);
    };
    socket.on("open", deliver);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { audio?: unknown; isFinal?: unknown; error?: unknown };
      if (typeof message.audio === "string" && message.audio) audio.push(Buffer.from(message.audio, "base64"));
      if (message.error) audio.fail(new Error(`elevenlabs stream error: ${String(message.error).slice(0, 200)}`));
      if (message.isFinal === true) {
        audio.end();
        socket.close();
      }
    });
    socket.on("error", (error) => audio.fail(error));
    socket.on("close", () => audio.fail(new Error("elevenlabs stream closed before the end")));
    const abort = () => {
      audio.end();
      socket.terminate();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return {
      send: (text) => {
        pending.push(JSON.stringify({ text: `${text} `, flush: true }));
        deliver();
      },
      end: () => {
        pending.push(JSON.stringify({ text: "" }));
        deliver();
      },
      audio: audio.iterate(),
    };
  }
}
