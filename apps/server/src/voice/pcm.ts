const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return (bytes / BYTES_PER_SAMPLE / sampleRate) * 1000;
}

/** Views little-endian 16-bit PCM bytes as samples, copying only when the bytes are unaligned. */
export function toSamples(pcm: Uint8Array): Int16Array {
  const length = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (pcm.byteOffset % BYTES_PER_SAMPLE === 0) return new Int16Array(pcm.buffer, pcm.byteOffset, length);
  return new Int16Array(pcm.slice(0, length * BYTES_PER_SAMPLE).buffer);
}

export function toBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Carries a dangling byte between network chunks so every output chunk holds whole 16-bit samples. */
export class SampleAligner {
  private carry: number | undefined;

  push(chunk: Uint8Array): Uint8Array {
    let bytes = chunk;
    if (this.carry !== undefined) {
      bytes = concatBytes([Uint8Array.of(this.carry), chunk]);
      this.carry = undefined;
    }
    if (bytes.byteLength % BYTES_PER_SAMPLE === 0) return bytes;
    this.carry = bytes[bytes.byteLength - 1];
    return bytes.subarray(0, bytes.byteLength - 1);
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Wraps mono PCM s16le in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

export interface DecodedWav {
  sampleRate: number;
  pcm: Uint8Array;
}

/** Reads a 16-bit PCM WAV file and returns mono samples (multichannel input is downmixed). */
export function decodeWav(data: Uint8Array): DecodedWav {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4));
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let format: { channels: number; sampleRate: number } | undefined;
  while (offset + 8 <= data.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      const audioFormat = view.getUint16(body, true);
      const bits = view.getUint16(body + 14, true);
      if ((audioFormat !== 1 && audioFormat !== 0xfffe) || bits !== 16) throw new Error("WAV must be 16-bit PCM");
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true) };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before format");
      const end = Math.min(body + size, data.byteLength);
      return { sampleRate: format.sampleRate, pcm: downmix(data.slice(body, end), format.channels) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data");
}

function downmix(pcm: Uint8Array, channels: number): Uint8Array {
  if (channels <= 1) return pcm;
  const input = toSamples(pcm);
  const frames = Math.floor(input.length / channels);
  const out = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += input[frame * channels + channel] ?? 0;
    out[frame] = Math.round(sum / channels);
  }
  return toBytes(out);
}

/**
 * Streaming linear-interpolation resampler. Output positions are computed with integer
 * arithmetic from absolute counters, so a chunked stream resamples exactly like one buffer.
 */
export class LinearResampler {
  private seen = 0;
  private produced = 0;
  private last: number | undefined;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {}

  process(input: Int16Array): Int16Array {
    if (this.fromRate === this.toRate) return input;
    const source = this.last === undefined ? input : prepend(this.last, input);
    const base = this.last === undefined ? this.seen : this.seen - 1;
    const output = new Int16Array(Math.ceil((input.length * this.toRate) / this.fromRate) + 2);
    let count = 0;
    for (;;) {
      const position = this.produced * this.fromRate;
      const index = Math.floor(position / this.toRate);
      if (index + 1 >= base + source.length) break;
      const a = source[index - base] as number;
      const b = source[index - base + 1] as number;
      output[count++] = Math.round(a + (b - a) * ((position % this.toRate) / this.toRate));
      this.produced++;
    }
    this.seen += input.length;
    if (source.length > 0) this.last = source[source.length - 1];
    return output.subarray(0, count);
  }
}

function prepend(sample: number, input: Int16Array): Int16Array {
  const out = new Int16Array(input.length + 1);
  out[0] = sample;
  out.set(input, 1);
  return out;
}

export function resample(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  return new LinearResampler(fromRate, toRate).process(samples);
}
