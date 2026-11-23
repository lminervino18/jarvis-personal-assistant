import type { AudioFormat } from "@jarvis/contracts";
import { SentenceChunker } from "./chunker.js";
import { LinearResampler, SampleAligner, toBytes, toSamples } from "./pcm.js";
import { RoboticEffect } from "./robotic-effect.js";
import { sanitizeForSpeech } from "./sanitizer.js";
import type { AudioSink, ReplySpeaker } from "./types.js";

const MAX_FRAME_BYTES = 8192;

export interface SynthesisRequest {
  signal: AbortSignal;
  previousText: string | undefined;
}

/** A provider-specific synthesizer: one sentence in, mono PCM s16le at `sampleRate` out. */
export interface SpeechEngine {
  readonly sampleRate: number;
  synthesize(text: string, request: SynthesisRequest): AsyncIterable<Uint8Array>;
}

/** One reply's continuous synthesis: sentences go in as they are ready, audio comes out in order. */
export interface SpeechStream {
  send(text: string): void;
  /** No more text; the remaining audio is generated and the stream ends. */
  end(): void;
  readonly audio: AsyncIterable<Uint8Array>;
}

/** An engine that can also keep one stream open for a whole reply. */
export interface StreamingSpeechEngine extends SpeechEngine {
  openStream(signal: AbortSignal): SpeechStream;
}

function canStream(engine: SpeechEngine): engine is StreamingSpeechEngine {
  return typeof (engine as Partial<StreamingSpeechEngine>).openStream === "function";
}

export interface QueuedSpeakerOptions {
  engine: SpeechEngine;
  output: AudioFormat;
  sink: AudioSink;
  signal: AbortSignal;
  effectIntensity: number;
}

export class QueuedReplySpeaker implements ReplySpeaker {
  firstAudioAt: number | undefined;
  private readonly chunker = new SentenceChunker();
  private readonly queue: string[] = [];
  private readonly controller = new AbortController();
  private readonly aligner = new SampleAligner();
  private readonly resampler: LinearResampler;
  private readonly effect: RoboticEffect;
  private drained: Promise<void> = Promise.resolve();
  private running = false;
  private cancelled = false;
  private failure: unknown;
  private begun = false;
  private ended = false;
  private lastSpoken: string | undefined;
  private stream: SpeechStream | undefined;
  private streamed: Promise<void> = Promise.resolve();
  private readonly sentToStream: string[] = [];
  private streamHeard = false;

  constructor(private readonly options: QueuedSpeakerOptions) {
    this.resampler = new LinearResampler(options.engine.sampleRate, options.output.sampleRate);
    this.effect = new RoboticEffect(options.output.sampleRate, options.effectIntensity);
    if (options.signal.aborted) this.cancel();
    else options.signal.addEventListener("abort", () => this.cancel(), { once: true });
    if (!this.cancelled && canStream(options.engine)) this.openStream(options.engine);
  }

  textDelta(text: string): void {
    if (this.stopped) return;
    this.enqueue(this.chunker.push(text));
  }

  toolStarted(): void {
    this.chunker.reset();
    this.queue.length = 0;
  }

  async finish(): Promise<void> {
    if (!this.stopped) this.enqueue(this.chunker.flush());
    this.stream?.end();
    await this.streamed;
    await this.drained;
    if (this.failure !== undefined) {
      this.close("error");
      throw this.failure;
    }
    this.close(this.cancelled ? "cancelled" : "complete");
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.chunker.reset();
    this.controller.abort();
    this.close("cancelled");
  }

  private get stopped(): boolean {
    return this.cancelled || this.failure !== undefined;
  }

  private enqueue(chunks: string[]): void {
    const stream = this.stream;
    if (stream) {
      for (const text of chunks.map(sanitizeForSpeech).filter(Boolean)) {
        this.sentToStream.push(text);
        stream.send(text);
      }
      return;
    }
    this.queue.push(...chunks);
    if (!this.running && this.queue.length > 0) this.drained = this.run();
  }

  /** Opens the reply's stream now, before any text, so its handshake overlaps the model's thinking. */
  private openStream(engine: StreamingSpeechEngine): void {
    const stream = engine.openStream(this.controller.signal);
    this.stream = stream;
    this.streamed = this.pump(stream);
  }

  private async pump(stream: SpeechStream): Promise<void> {
    try {
      for await (const chunk of stream.audio) {
        if (this.cancelled) return;
        this.streamHeard = true;
        await this.write(this.process(chunk));
      }
    } catch (error) {
      if (this.cancelled) return;
      if (this.streamHeard) {
        this.failure = error;
        return;
      }
      this.stream = undefined;
      this.enqueue(this.sentToStream.splice(0));
    }
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) await this.speak(this.queue.shift() as string);
    } catch (error) {
      if (!this.cancelled) this.failure = error;
    } finally {
      this.running = false;
    }
  }

  private async speak(raw: string): Promise<void> {
    const text = sanitizeForSpeech(raw);
    if (!text) return;
    const audio = this.options.engine.synthesize(text, { signal: this.controller.signal, previousText: this.lastSpoken });
    for await (const chunk of audio) {
      if (this.cancelled) return;
      await this.write(this.process(chunk));
    }
    this.lastSpoken = text;
  }

  private process(chunk: Uint8Array): Uint8Array {
    const samples = this.resampler.process(toSamples(this.aligner.push(chunk)));
    return toBytes(this.effect.process(samples));
  }

  private async write(pcm: Uint8Array): Promise<void> {
    const { sink, output } = this.options;
    for (let offset = 0; offset < pcm.byteLength; offset += MAX_FRAME_BYTES) {
      if (this.cancelled) return;
      if (!this.begun) {
        this.begun = true;
        sink.begin(output, this.effect.active);
        this.firstAudioAt = performance.now();
      }
      if (!sink.write(pcm.subarray(offset, offset + MAX_FRAME_BYTES))) await sink.waitForDrain();
    }
  }

  private close(reason: "complete" | "cancelled" | "error"): void {
    if (this.ended || !this.begun) return;
    this.ended = true;
    this.options.sink.end(reason);
  }
}
