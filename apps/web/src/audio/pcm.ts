export const CAPTURE_SAMPLE_RATE = 16000;
export const CAPTURE_FRAME_MS = 20;
export const CAPTURE_FRAME_SAMPLES = (CAPTURE_SAMPLE_RATE * CAPTURE_FRAME_MS) / 1000;

const SILENCE_DBFS = -100;

export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
}

export function pcm16ToBytes(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);
  return bytes;
}

/** Decodes little-endian s16 PCM (any byte offset) into float samples in [-1, 1). */
export function pcm16BytesToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  return samples;
}

export function rmsDbfs(pcm: Int16Array): number {
  if (pcm.length === 0) return SILENCE_DBFS;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const sample = (pcm[i] ?? 0) / 0x8000;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / pcm.length);
  return rms > 0 ? Math.max(SILENCE_DBFS, 20 * Math.log10(rms)) : SILENCE_DBFS;
}

/** Maps a dBFS level to 0..1 for visuals (-60 dBFS and below is 0). */
export function levelFromDbfs(dbfs: number): number {
  return Math.max(0, Math.min(1, (dbfs + 60) / 60));
}

/**
 * Streaming box-filter decimator: averages the input samples that fall inside each output
 * period, which is enough anti-aliasing for speech at 16 kHz.
 */
export class Downsampler {
  private readonly ratio: number;
  private boundary: number;
  private index = 0;
  private sum = 0;
  private count = 0;

  constructor(inputRate: number, outputRate = CAPTURE_SAMPLE_RATE) {
    if (inputRate < outputRate) throw new Error("input rate must be at least the output rate");
    this.ratio = inputRate / outputRate;
    this.boundary = this.ratio;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const output = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i] ?? 0;
      this.count++;
      this.index++;
      if (this.index >= this.boundary) {
        output[written++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.boundary += this.ratio;
      }
    }
    return output.subarray(0, written);
  }
}

/** Cuts a stream of samples into fixed-size frames. */
export class Framer {
  private pending: Int16Array;
  private filled = 0;

  constructor(private readonly frameSamples: number) {
    this.pending = new Int16Array(frameSamples);
  }

  push(samples: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.frameSamples - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSamples) {
        frames.push(this.pending);
        this.pending = new Int16Array(this.frameSamples);
        this.filled = 0;
      }
    }
    return frames;
  }
}
