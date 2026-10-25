import { describe, expect, it } from "vitest";
import { LinearResampler, SampleAligner, concatBytes, decodeWav, encodeWav, pcmDurationMs, resample, toBytes, toSamples } from "./pcm.js";

function tone(sampleRate: number, hz: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  return out;
}

describe("WAV", () => {
  it("encodes a canonical header and round-trips", () => {
    const pcm = toBytes(tone(16000, 440, 0.1));
    const wav = encodeWav(pcm, 16000);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.pcm).toEqual(pcm);
  });

  it("skips extra chunks, downmixes stereo and rejects non-PCM input", () => {
    const stereo = new Int16Array([1000, 3000, -2000, -4000]);
    const wav = encodeWav(toBytes(stereo), 8000);
    new DataView(wav.buffer).setUint16(22, 2, true);
    expect([...toSamples(decodeWav(wav).pcm)]).toEqual([2000, -3000]);
    expect(() => decodeWav(new Uint8Array(20))).toThrow("not a WAV file");
  });
});

describe("resampling", () => {
  function peakFrequency(samples: Int16Array, sampleRate: number): number {
    let best = 0;
    let bestPower = 0;
    for (let hz = 100; hz < sampleRate / 2; hz += 10) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < samples.length; i++) {
        const angle = (2 * Math.PI * hz * i) / sampleRate;
        re += (samples[i] as number) * Math.cos(angle);
        im += (samples[i] as number) * Math.sin(angle);
      }
      const power = re * re + im * im;
      if (power > bestPower) {
        bestPower = power;
        best = hz;
      }
    }
    return best;
  }

  it.each([
    [16000, 24000],
    [24000, 16000],
    [22050, 16000],
    [16000, 22050],
  ])("keeps the pitch and duration from %i to %i Hz", (from, to) => {
    const output = resample(tone(from, 440, 0.5), from, to);
    expect(Math.abs(output.length - 0.5 * to)).toBeLessThanOrEqual(2);
    expect(Math.abs(peakFrequency(output, to) - 440)).toBeLessThanOrEqual(10);
  });

  it("returns the same samples when the rates match", () => {
    const input = tone(16000, 300, 0.1);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("resamples a chunked stream exactly like one buffer", () => {
    const input = tone(22050, 330, 0.4);
    const whole = resample(input, 22050, 16000);
    const resampler = new LinearResampler(22050, 16000);
    const parts = [input.subarray(0, 1), input.subarray(1, 777), input.subarray(777, 778), input.subarray(778)].map((part) => resampler.process(part));
    expect(Int16Array.from(parts.flatMap((part) => [...part]))).toEqual(whole);
  });

  it("interpolates linearly between samples", () => {
    const output = resample(Int16Array.from([0, 100, 200, 300]), 8000, 16000);
    expect([...output]).toEqual([0, 50, 100, 150, 200, 250]);
  });
});

describe("helpers", () => {
  it("realigns odd-sized network chunks to whole samples", () => {
    const bytes = toBytes(Int16Array.from([1, -2, 3, -4, 5]));
    const aligner = new SampleAligner();
    const parts = [bytes.subarray(0, 3), bytes.subarray(3, 4), bytes.subarray(4, 9), bytes.subarray(9)].map((part) => aligner.push(part));
    expect(parts.every((part) => part.byteLength % 2 === 0)).toBe(true);
    expect(concatBytes(parts)).toEqual(bytes);
  });

  it("reads samples from unaligned views and measures duration", () => {
    const backing = new Uint8Array([0, ...toBytes(Int16Array.from([7, -7]))]);
    expect([...toSamples(backing.subarray(1))]).toEqual([7, -7]);
    expect(pcmDurationMs(32000, 16000)).toBe(1000);
  });
});
