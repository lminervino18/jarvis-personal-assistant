import { describe, expect, it } from "vitest";
import { EnergyVad, bargeInVadOptions, defaultVadOptions, type VadDecision } from "./vad.js";

const FRAME_MS = defaultVadOptions.frameMs;

function frames(level: number, ms: number): number[] {
  return new Array<number>(Math.round(ms / FRAME_MS)).fill(level);
}

function run(vad: EnergyVad, levels: number[]): VadDecision[] {
  return levels.map((level) => vad.push(level));
}

function settled(options = defaultVadOptions): EnergyVad {
  const vad = new EnergyVad(options);
  run(vad, frames(-62, options.warmupMs + 200));
  return vad;
}

describe("EnergyVad", () => {
  it("stays idle in a quiet room", () => {
    const decisions = run(settled(), frames(-62, 2000));
    expect(new Set(decisions)).toEqual(new Set(["idle"]));
  });

  it("confirms speech after the minimum voiced time and ends it after the silence window", () => {
    const vad = settled();
    const decisions = run(vad, [...frames(-30, 600), ...frames(-62, 1200)]);
    const start = decisions.indexOf("start");
    const end = decisions.indexOf("end");
    expect(start * FRAME_MS).toBe(defaultVadOptions.minSpeechMs - FRAME_MS);
    expect((end - 600 / FRAME_MS + 1) * FRAME_MS).toBe(defaultVadOptions.endSilenceMs);
    expect(decisions.slice(end + 1).every((d) => d === "idle")).toBe(true);
  });

  it("does not cut a turn on a short pause between phrases", () => {
    const vad = settled();
    const decisions = run(vad, [...frames(-30, 500), ...frames(-62, 600), ...frames(-30, 500)]);
    expect(decisions).not.toContain("end");
    expect(decisions.at(-1)).toBe("speech");
  });

  it("discards a short blip as noise", () => {
    const vad = settled();
    const decisions = run(vad, [...frames(-30, 60), ...frames(-62, 400)]);
    expect(decisions).not.toContain("start");
    expect(decisions.at(-1)).toBe("idle");
  });

  it("keeps speech through levels between the stop and start thresholds", () => {
    const vad = settled();
    run(vad, frames(-30, 400));
    const between = (vad.startThresholdDbfs + vad.stopThresholdDbfs) / 2;
    expect(between).toBeGreaterThan(vad.stopThresholdDbfs);
    const decisions = run(vad, frames(between, 2000));
    expect(new Set(decisions)).toEqual(new Set(["speech"]));
  });

  it("forces the end of an utterance at the maximum length", () => {
    const vad = settled({ ...defaultVadOptions, maxUtteranceMs: 2000 });
    const decisions = run(vad, frames(-30, 4000));
    expect(decisions).toContain("end");
  });

  it("measures a loud room during warm-up instead of reading it as speech", () => {
    const vad = new EnergyVad();
    const decisions = run(vad, frames(-38, 2000));
    expect(new Set(decisions)).toEqual(new Set(["idle"]));
    expect(vad.noiseFloorDbfs).toBeCloseTo(-38, 0);
    expect(run(vad, frames(-15, 400))).toContain("start");
  });

  it("raises its floor slowly and lowers it fast when the room changes", () => {
    const vad = settled();
    const quiet = vad.noiseFloorDbfs;
    run(vad, frames(-56, 500));
    const afterNoise = vad.noiseFloorDbfs;
    expect(afterNoise).toBeGreaterThan(quiet);
    run(vad, frames(-80, 200));
    expect(vad.noiseFloorDbfs).toBeLessThan(afterNoise);
  });

  it("learns the echo level with the barge-in settings and only reacts to speech well above it", () => {
    const vad = new EnergyVad(bargeInVadOptions);
    expect(run(vad, frames(-35, 1500))).not.toContain("start");
    expect(vad.noiseFloorDbfs).toBeCloseTo(-35, 0);
    expect(run(vad, frames(-5, 600))).toContain("start");
  });
});
