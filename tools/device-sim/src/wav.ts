const HEADER_BYTES = 44;
const RIFF_CHUNK_HEADER_BYTES = 8;

export interface WavAudio {
  pcm: Uint8Array;
  sampleRate: number;
}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));
}

/** Reads a mono 16-bit PCM WAV file; any other layout is rejected. */
export function parseWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let sampleRate = 0;
  let offset = 12;
  while (offset + RIFF_CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const id = tag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + RIFF_CHUNK_HEADER_BYTES;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error("only mono 16-bit PCM WAV is supported");
      sampleRate = view.getUint32(body + 4, true);
    }
    if (id === "data") {
      if (sampleRate === 0) throw new Error("WAV data chunk before fmt chunk");
      const end = Math.min(body + size, bytes.byteLength);
      return { pcm: bytes.subarray(body, end - ((end - body) % 2)), sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Wraps mono PCM s16le in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav(pcm: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
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
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}

/** Synthetic sine tone as PCM s16le, for tests and quick manual runs without real audio. */
export function toneAudio(seconds: number, sampleRate: number, frequency = 440): Uint8Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(4000 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  return new Uint8Array(samples.buffer);
}
