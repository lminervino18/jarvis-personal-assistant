import { describe, expect, it } from "vitest";
import { resetLabel } from "./UsageGroup.js";

describe("plan usage labels", () => {
  it("says the time for a reset today and the weekday for a later one", () => {
    const now = new Date(2026, 10, 28, 3, 30);
    expect(resetLabel(new Date(2026, 10, 28, 5, 20).toISOString(), now)).toBe("a las 05:20");
    expect(resetLabel(new Date(2026, 10, 30, 1, 40).toISOString(), now)).toMatch(/^el lun 01:40$/);
  });
});
