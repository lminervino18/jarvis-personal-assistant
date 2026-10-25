import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./latency.js";

describe("latency statistics", () => {
  it("uses nearest-rank percentiles", () => {
    const values = [900, 100, 300, 200, 500, 400, 700, 600, 800, 1000];
    expect(percentile(values, 0.5)).toBe(500);
    expect(percentile(values, 0.95)).toBe(1000);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("summarizes samples and reports nothing for an empty one", () => {
    expect(summarize([10, 20, 30])).toEqual({ count: 3, p50: 20, p95: 30, max: 30 });
    expect(summarize([])).toBeUndefined();
  });
});
