import { describe, expect, it } from "vitest";
import { lockProgress, noteGesture } from "./note-gesture.js";

const start = { x: 300, y: 700 };

describe("voice note gesture", () => {
  it("keeps holding for small movements", () => {
    expect(noteGesture(start, { x: 290, y: 680 })).toBe("hold");
  });

  it("locks when the finger slides up far enough", () => {
    expect(noteGesture(start, { x: 295, y: 620 })).toBe("lock");
    expect(lockProgress(start, { x: 300, y: 665 })).toBe(0.5);
    expect(lockProgress(start, { x: 300, y: 750 })).toBe(0);
  });

  it("cancels when the finger slides left far enough, unless it went further up", () => {
    expect(noteGesture(start, { x: 180, y: 690 })).toBe("cancel");
    expect(noteGesture(start, { x: 160, y: 540 })).toBe("lock");
  });
});
