import { afterEach, describe, expect, it, vi } from "vitest";
import { haptic } from "./haptics.js";

afterEach(() => vi.unstubAllGlobals());

describe("haptics", () => {
  it("vibrates briefly where the browser can", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    haptic();
    expect(vibrate).toHaveBeenCalledWith(12);
  });
});
