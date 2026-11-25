import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type * as Sherpa from "sherpa-onnx-node";

/** Turns 16-bit mono PCM into a speaker embedding. */
export type Embedder = (samples: Float32Array, sampleRate: number) => Promise<Float32Array>;

export interface SpeakerCheckOptions {
  /** Where the owner's averaged embedding is kept. */
  voiceprintPath: string;
  /** Below this cosine similarity the speech is not the owner's. */
  threshold: number;
  embed: Embedder;
}

export interface SpeakerVerdict {
  owner: boolean;
  score: number;
}

/** Shorter speech ("sí", "dale") is too short to judge and is always accepted. */
const MIN_SECONDS = 1;

export function pcmToFloat(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

function normalize(vector: Float32Array): Float32Array {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

/**
 * Tells the owner's voice from anyone else's: the TV, people around, the reply's own echo. The
 * voiceprint is the average of the embeddings of the phrases the owner recorded.
 */
export class SpeakerCheck {
  private voiceprint: Float32Array | null | undefined;

  constructor(private readonly options: SpeakerCheckOptions) {}

  enrolled(): boolean {
    return this.load() !== null;
  }

  /** Whether the speech is the owner's, or undefined when there is no voiceprint or too little audio. */
  async matches(pcm: Buffer, sampleRate: number): Promise<SpeakerVerdict | undefined> {
    const print = this.load();
    if (!print || pcm.length < sampleRate * 2 * MIN_SECONDS) return undefined;
    const score = cosine(normalize(await this.options.embed(pcmToFloat(pcm), sampleRate)), print);
    return { owner: score >= this.options.threshold, score: Math.round(score * 1000) / 1000 };
  }

  /** Builds and stores the voiceprint from the owner's recordings. */
  async enroll(recordings: readonly Buffer[], sampleRate: number): Promise<void> {
    const embeddings = await Promise.all(recordings.map((pcm) => this.options.embed(pcmToFloat(pcm), sampleRate).then(normalize)));
    const sum = new Float32Array(embeddings[0]?.length ?? 0);
    for (const embedding of embeddings) embedding.forEach((value, i) => (sum[i] = (sum[i] as number) + value));
    this.voiceprint = normalize(sum);
    mkdirSync(dirname(this.options.voiceprintPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.voiceprintPath, JSON.stringify({ embedding: [...this.voiceprint], recordings: recordings.length }), { mode: 0o600 });
  }

  forget(): void {
    rmSync(this.options.voiceprintPath, { force: true });
    this.voiceprint = null;
  }

  private load(): Float32Array | null {
    if (this.voiceprint !== undefined) return this.voiceprint;
    this.voiceprint = existsSync(this.options.voiceprintPath)
      ? new Float32Array((JSON.parse(readFileSync(this.options.voiceprintPath, "utf8")) as { embedding: number[] }).embedding)
      : null;
    return this.voiceprint;
  }
}

/** The sherpa-onnx embedder, loaded on first use so the server starts without paying for the model. */
export function sherpaEmbedder(modelPath: string): Embedder {
  let extractor: Sherpa.SpeakerEmbeddingExtractor | undefined;
  return async (samples, sampleRate) => {
    if (!extractor) {
      const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as typeof Sherpa;
      extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false });
    }
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate, samples });
    stream.inputFinished();
    return Float32Array.from(extractor.compute(stream));
  };
}
