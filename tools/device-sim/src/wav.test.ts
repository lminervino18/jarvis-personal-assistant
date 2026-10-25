import { describe, expect, it } from "vitest";
import { encodeWav, parseWav, toneAudio } from "./wav.js";

describe("wav", () => {
  it("round-trips synthetic PCM", () => {
    const pcm = toneAudio(0.1, 16000);
    const parsed = parseWav(encodeWav(pcm, 16000));
    expect(parsed.sampleRate).toBe(16000);
    expect(Array.from(parsed.pcm)).toEqual(Array.from(pcm));
  });

  it("skips unknown chunks and clamps a data size larger than the file", () => {
    const wav = encodeWav(toneAudio(0.01, 16000), 16000);
    const extra = new Uint8Array([...wav.subarray(0, 36), ...new TextEncoder().encode("LIST"), 2, 0, 0, 0, 1, 2, ...wav.subarray(36)]);
    new DataView(extra.buffer).setUint32(extra.length - wav.length + 36 + 8 + 2 + 4, 0xffffffff, true);
    expect(parseWav(extra).pcm.byteLength).toBe(toneAudio(0.01, 16000).byteLength);
  });

  it("rejects what is not mono 16-bit PCM", () => {
    expect(() => parseWav(new TextEncoder().encode("not a wav file at all"))).toThrow("RIFF");
    const stereo = encodeWav(new Uint8Array(4), 16000);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow("mono 16-bit");
  });
});
