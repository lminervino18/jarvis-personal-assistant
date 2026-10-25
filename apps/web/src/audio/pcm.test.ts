import { describe, expect, it } from "vitest";
import { Downsampler, Framer, floatToPcm16, levelFromDbfs, pcm16BytesToFloat, pcm16ToBytes, rmsDbfs } from "./pcm.js";

function sine(rate: number, frequency: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return samples;
}

describe("PCM conversion", () => {
  it("clamps and scales floats to s16", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("round-trips through little-endian bytes", () => {
    const pcm = new Int16Array([0, 1, -1, 12345, -12345, 32767, -32768]);
    const bytes = pcm16ToBytes(pcm);
    expect(bytes[2]).toBe(1);
    expect(bytes[3]).toBe(0);
    const back = Array.from(floatToPcm16(pcm16BytesToFloat(bytes)));
    back.forEach((value, i) => expect(Math.abs(value - (pcm[i] ?? 0))).toBeLessThanOrEqual(1));
  });

  it("decodes from a view with a non-zero byte offset and ignores a dangling byte", () => {
    const bytes = pcm16ToBytes(new Int16Array([100, 200, 300]));
    const view = bytes.subarray(2, 5);
    expect(pcm16BytesToFloat(view)).toHaveLength(1);
    expect(pcm16BytesToFloat(view)[0]).toBeCloseTo(200 / 0x8000, 6);
  });
});

describe("levels", () => {
  it("measures a full-scale sine near -3 dBFS", () => {
    expect(rmsDbfs(floatToPcm16(sine(16000, 440, 0.1, 1)))).toBeCloseTo(-3, 0);
  });

  it("reports digital silence and empty input as the floor", () => {
    expect(rmsDbfs(new Int16Array(160))).toBe(-100);
    expect(rmsDbfs(new Int16Array(0))).toBe(-100);
  });

  it("maps dBFS to a 0..1 visual level", () => {
    expect(levelFromDbfs(-80)).toBe(0);
    expect(levelFromDbfs(-30)).toBeCloseTo(0.5);
    expect(levelFromDbfs(0)).toBe(1);
    expect(levelFromDbfs(6)).toBe(1);
  });
});

describe("Downsampler", () => {
  it("produces 16 kHz output at the right length from 48 kHz", () => {
    const downsampler = new Downsampler(48000);
    const output = downsampler.process(sine(48000, 440, 1));
    expect(output.length).toBe(16000);
  });

  it("keeps the stream continuous across chunk boundaries for a fractional ratio", () => {
    const input = sine(44100, 440, 1);
    const whole = new Downsampler(44100).process(input);
    const chunked = new Downsampler(44100);
    const parts: number[] = [];
    for (let offset = 0; offset < input.length; offset += 128) {
      parts.push(...chunked.process(input.subarray(offset, offset + 128)));
    }
    expect(parts.length).toBe(whole.length);
    expect(Math.abs(whole.length - 16000)).toBeLessThanOrEqual(1);
    parts.forEach((value, i) => expect(value).toBeCloseTo(whole[i] ?? 0, 5));
  });

  it("preserves speech-band tone amplitude and attenuates content above Nyquist", () => {
    const speech = new Downsampler(48000).process(sine(48000, 440, 0.5, 0.5));
    const alias = new Downsampler(48000).process(sine(48000, 15000, 0.5, 0.5));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);
    expect(rms(speech)).toBeGreaterThan(0.33);
    expect(rms(alias)).toBeLessThan(rms(speech) / 2);
  });

  it("rejects an input rate below the output rate", () => {
    expect(() => new Downsampler(8000)).toThrow();
  });

  it("copies the input when the rates match", () => {
    const input = new Float32Array([0.1, 0.2]);
    const output = new Downsampler(16000).process(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(output).not.toBe(input);
  });
});

describe("Framer", () => {
  it("cuts samples into fixed frames and keeps the remainder", () => {
    const framer = new Framer(4);
    expect(framer.push(new Int16Array([1, 2, 3]))).toHaveLength(0);
    const frames = framer.push(new Int16Array([4, 5, 6, 7, 8, 9]));
    expect(frames.map((frame) => Array.from(frame))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const last = framer.push(new Int16Array([10, 11, 12]));
    expect(last.map((frame) => Array.from(frame))).toEqual([[9, 10, 11, 12]]);
  });
});
