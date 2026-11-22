import { describe, expect, it } from "vitest";
import { clip, withinBudget } from "./digest.js";

describe("digest helpers", () => {
  it("clips long text and leaves short text alone", () => {
    expect(clip("hola", 10)).toBe("hola");
    expect(clip("a".repeat(50), 10)).toBe(`${"a".repeat(10)}…`);
  });

  it("keeps the newest items that fit the budget, always at least one", () => {
    const items = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
    const newest = withinBudget(items, 220);
    expect(newest.kept).toEqual(items.slice(1));
    expect(newest.omitted).toBe(1);
    expect(withinBudget(items, 220, "oldest").kept).toEqual(items.slice(0, 2));
    expect(withinBudget(items, 1).kept).toEqual([items[2]]);
  });
});
