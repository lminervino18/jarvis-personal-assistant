import { describe, expect, it } from "vitest";
import { RoboticEffect } from "./robotic-effect.js";

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function noise(length: number): Int16Array {
  let state = 12345;
  return Int16Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.round((state / 2147483648 - 0.5) * 12000);
  });
}

describe("RoboticEffect", () => {
  const input = noise(11025);

  it("is a bypass at intensity 0", () => {
    const effect = new RoboticEffect(22050, 0);
    expect(effect.active).toBe(false);
    expect(effect.process(input)).toBe(input);
  });

  it("changes the signal without changing its level much or clipping", () => {
    const effect = new RoboticEffect(22050, 0.5);
    const output = effect.process(input);
    expect(effect.active).toBe(true);
    expect(output).not.toEqual(input);
    const ratio = rms(output) / rms(input);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
    expect(Math.max(...output)).toBeLessThan(32767);
  });

  it("colors the signal more at higher intensity", () => {
    const difference = (intensity: number) => {
      const output = new RoboticEffect(22050, intensity).process(input);
      return rms(output.map((value, i) => value - (input[i] as number)));
    };
    expect(difference(0.1)).toBeLessThan(difference(0.4));
    expect(difference(0.4)).toBeLessThan(difference(1));
  });

  it("processes a chunked stream exactly like one buffer", () => {
    const whole = new RoboticEffect(22050, 0.4).process(input);
    const chunked = new RoboticEffect(22050, 0.4);
    const parts = [input.subarray(0, 100), input.subarray(100, 4001), input.subarray(4001)].map((part) => chunked.process(part));
    expect(Int16Array.from(parts.flatMap((part) => [...part]))).toEqual(whole);
  });

  it("clamps out-of-range intensity", () => {
    expect(new RoboticEffect(16000, 7).intensity).toBe(1);
    expect(new RoboticEffect(16000, -1).active).toBe(false);
  });
});
