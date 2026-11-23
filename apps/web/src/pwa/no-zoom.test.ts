import { describe, expect, it } from "vitest";
import { preventZoom } from "./no-zoom.js";

describe("no zoom", () => {
  it("stops pinch gestures and two-finger moves but lets one finger scroll", () => {
    const target = new EventTarget();
    preventZoom(target);
    const pinch = new Event("gesturestart", { cancelable: true });
    target.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);

    const move = (touches: number) => {
      const event = new Event("touchmove", { cancelable: true });
      Object.defineProperty(event, "touches", { value: { length: touches } });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(move(2)).toBe(true);
    expect(move(1)).toBe(false);
  });
});
