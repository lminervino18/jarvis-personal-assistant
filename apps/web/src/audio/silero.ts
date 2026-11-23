import type * as Ort from "onnxruntime-web/wasm";
import { SpeechVad, playbackSpeechVadOptions, speechVadOptions } from "./speech-vad.js";
import type { DetectorFactory } from "./voice-loop.js";

export const SILERO_WINDOW_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const SAMPLE_RATE = 16000;

/** Silero VAD v6 on onnxruntime-web (single-threaded WASM): speech probability per 32 ms window at 16 kHz. */
export class SileroModel {
  private state: Ort.Tensor;
  private context = new Float32Array(CONTEXT_SAMPLES);

  private constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
    private readonly sampleRate: Ort.Tensor,
  ) {
    this.state = this.emptyState();
  }

  /** Loads the runtime and the model on demand, so they only download when the owner starts a call. */
  static async load(): Promise<SileroModel> {
    const [ort, wasm, loader, model] = await Promise.all([
      import("onnxruntime-web/wasm"),
      import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
      import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
      import("@ricky0123/vad-web/dist/silero_vad_v6.onnx?url"),
    ]);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = { wasm: wasm.default, mjs: loader.default };
    const bytes = await (await fetch(model.default)).arrayBuffer();
    const session = await ort.InferenceSession.create(bytes);
    return new SileroModel(ort, session, new ort.Tensor("int64", [BigInt(SAMPLE_RATE)]));
  }

  reset(): void {
    this.state = this.emptyState();
    this.context = new Float32Array(CONTEXT_SAMPLES);
  }

  async probability(window: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT_SAMPLES + window.length);
    input.set(this.context, 0);
    input.set(window, CONTEXT_SAMPLES);
    this.context = window.slice(-CONTEXT_SAMPLES);
    const output = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, input.length]),
      state: this.state,
      sr: this.sampleRate,
    });
    const next = output["stateN"];
    const speech = output["output"]?.data[0];
    if (!next || typeof speech !== "number") throw new Error("unexpected Silero output");
    this.state = next;
    return speech;
  }

  private emptyState(): Ort.Tensor {
    return new this.ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }
}

/**
 * Feeds 20 ms capture frames to Silero in 512-sample windows and answers each frame with the
 * latest probability. Inference runs asynchronously, so a frame sees a result at most one window late.
 */
export class SileroDetector {
  private readonly pending = new Float32Array(SILERO_WINDOW_SAMPLES);
  private filled = 0;
  private latest = 0;
  private busy = false;

  constructor(private readonly model: SileroModel) {}

  reset(): void {
    this.filled = 0;
    this.latest = 0;
    this.model.reset();
  }

  push(frame: Int16Array): number {
    let offset = 0;
    while (offset < frame.length) {
      const take = Math.min(SILERO_WINDOW_SAMPLES - this.filled, frame.length - offset);
      for (let i = 0; i < take; i++) this.pending[this.filled + i] = (frame[offset + i] ?? 0) / 32768;
      this.filled += take;
      offset += take;
      if (this.filled === SILERO_WINDOW_SAMPLES) {
        this.run(this.pending.slice());
        this.filled = 0;
      }
    }
    return this.latest;
  }

  private run(window: Float32Array): void {
    if (this.busy) return;
    this.busy = true;
    this.model
      .probability(window)
      .then((probability) => void (this.latest = probability))
      .catch(() => void (this.latest = 0))
      .finally(() => void (this.busy = false));
  }
}

/** Utterance detectors backed by one Silero stream: normal listening, or stricter while the reply plays. */
export function sileroDetectors(model: SileroModel): DetectorFactory {
  const silero = new SileroDetector(model);
  return (playing) => {
    const vad = new SpeechVad(playing ? playbackSpeechVadOptions : speechVadOptions);
    return {
      push: (frame) => vad.push(silero.push(frame)),
      reset: () => vad.reset(),
      get voicedMs() {
        return vad.voicedTotalMs;
      },
    };
  };
}

/** Loads Silero for the voice loop. */
export async function loadSileroDetectors(): Promise<DetectorFactory> {
  return sileroDetectors(await SileroModel.load());
}
