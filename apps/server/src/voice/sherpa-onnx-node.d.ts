declare module "sherpa-onnx-node" {
  export interface EmbeddingStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads?: number; debug?: boolean });
    readonly dim: number;
    createStream(): EmbeddingStream;
    compute(stream: EmbeddingStream): Float32Array;
  }
}
