import type { AudioFormat } from "@jarvis/contracts";
import { QueuedReplySpeaker, type SpeechEngine } from "./reply-speaker.js";
import type { AudioSink, ReplySpeaker, TextToSpeechService } from "./types.js";

export const DEFAULT_ROBOTIC_INTENSITY = 0.15;

export interface EngineTtsOptions {
  provider: string;
  engine: SpeechEngine;
  effectIntensity?: number;
}

/** Adapts a sentence-level SpeechEngine to the TextToSpeechService contract. */
export class EngineTextToSpeech implements TextToSpeechService {
  readonly provider: string;
  private readonly engine: SpeechEngine;
  private readonly effectIntensity: number;

  constructor(options: EngineTtsOptions) {
    this.provider = options.provider;
    this.engine = options.engine;
    this.effectIntensity = options.effectIntensity ?? DEFAULT_ROBOTIC_INTENSITY;
  }

  available(): boolean {
    return true;
  }

  chooseOutputFormat(clientFormats: readonly AudioFormat[]): AudioFormat | null {
    const native = this.engine.sampleRate;
    const ranked = [...clientFormats].sort((a, b) => distance(a.sampleRate, native) - distance(b.sampleRate, native));
    return ranked[0] ?? null;
  }

  createSpeaker(options: { turnId: string; output: AudioFormat; sink: AudioSink; signal: AbortSignal }): ReplySpeaker {
    return new QueuedReplySpeaker({
      engine: this.engine,
      output: options.output,
      sink: options.sink,
      signal: options.signal,
      effectIntensity: this.effectIntensity,
    });
  }
}

function distance(rate: number, native: number): number {
  return rate >= native ? rate - native : (native - rate) * 2;
}
