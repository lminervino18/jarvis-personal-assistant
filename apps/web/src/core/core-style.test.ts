import { assistantStates } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { CoreAnimator, coreStyles, mixColor, smoothLevel, targetLevel, palette } from "./core-style.js";
import { QualityGovernor } from "./loop.js";

describe("core styles", () => {
  it("defines a style for every state", () => {
    for (const state of assistantStates) expect(coreStyles[state]).toBeDefined();
  });

  it("follows the microphone only while listening and the speech only while speaking", () => {
    const levels = { input: 0.7, output: 0.4 };
    expect(targetLevel(coreStyles.listening, levels)).toBe(0.7);
    expect(targetLevel(coreStyles.speaking, levels)).toBe(0.4);
    for (const state of assistantStates.filter((s) => s !== "listening" && s !== "speaking")) {
      expect(targetLevel(coreStyles[state], levels)).toBe(0);
    }
  });

  it("uses amber only for tool use, interruption and errors", () => {
    const amber = assistantStates.filter((s) => coreStyles[s].color === palette.amber || coreStyles[s].accentRing >= 0);
    expect(amber).toEqual(["using_tool", "interrupted", "error"]);
  });
});

describe("level smoothing", () => {
  it("rises faster than it falls", () => {
    const rise = smoothLevel(0, 1, 50);
    const fall = 1 - smoothLevel(1, 0, 50);
    expect(rise).toBeGreaterThan(fall);
    expect(smoothLevel(0.5, 0.5, 16)).toBe(0.5);
  });

  it("converges to the target regardless of frame size", () => {
    let fine = 0;
    for (let i = 0; i < 100; i++) fine = smoothLevel(fine, 1, 10);
    expect(fine).toBeGreaterThan(0.99);
    expect(smoothLevel(0, 1, 1000)).toBeGreaterThan(0.99);
  });
});

describe("CoreAnimator", () => {
  it("rotates the rings in alternating directions, faster in thinking than idle", () => {
    const idle = new CoreAnimator();
    const thinking = new CoreAnimator();
    const start = [...idle.angles];
    idle.step(100, coreStyles.idle, { input: 0, output: 0 }, false);
    thinking.step(100, coreStyles.thinking, { input: 0, output: 0 }, false);
    expect(idle.angles[0]).toBeGreaterThan(start[0] as number);
    expect(idle.angles[1]).toBeLessThan(start[1] as number);
    expect(Math.abs((thinking.angles[0] as number) - (start[0] as number))).toBeGreaterThan(Math.abs((idle.angles[0] as number) - (start[0] as number)));
  });

  it("stops rotating with reduced motion but still follows the level and color", () => {
    const animator = new CoreAnimator();
    const start = [...animator.angles];
    for (let i = 0; i < 60; i++) animator.step(16, coreStyles.speaking, { input: 0, output: 0.8 }, true);
    expect(animator.angles).toEqual(start);
    expect(animator.level).toBeGreaterThan(0.7);
    expect(Math.abs(animator.color[0] - palette.cyan[0])).toBeLessThan(3);
  });

  it("blends colors", () => {
    expect(mixColor([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
  });
});

describe("QualityGovernor", () => {
  it("lowers quality after a window of slow frames and recovers after fast ones", () => {
    const governor = new QualityGovernor(2);
    for (let i = 0; i < 90; i++) governor.record(40);
    expect(governor.quality).toBe(1);
    for (let i = 0; i < 90; i++) governor.record(40);
    expect(governor.quality).toBe(0);
    for (let i = 0; i < 90; i++) governor.record(40);
    expect(governor.quality).toBe(0);
    for (let i = 0; i < 90; i++) governor.record(8);
    expect(governor.quality).toBe(1);
  });

  it("respects a quality ceiling", () => {
    const governor = new QualityGovernor(2);
    governor.capAt(1);
    expect(governor.quality).toBe(1);
    for (let i = 0; i < 180; i++) governor.record(5);
    expect(governor.quality).toBe(1);
  });
});
