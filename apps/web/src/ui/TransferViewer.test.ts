import { describe, expect, it } from "vitest";
import { zoomWidth } from "./TransferViewer.js";

describe("zooming a photo in Transferencias", () => {
  const phone = { width: 366, height: 652 };

  it("fits a tall screenshot to the width, to read it scrolling down from the top", () => {
    expect(zoomWidth({ width: 1180, height: 8000 }, phone)).toBe(366);
  });

  it("enlarges a regular photo up to three times the screen, never past its own size", () => {
    expect(zoomWidth({ width: 1600, height: 1200 }, phone)).toBe(1098);
    expect(zoomWidth({ width: 500, height: 400 }, phone)).toBe(500);
  });

  it("never makes a photo narrower than the screen", () => {
    expect(zoomWidth({ width: 120, height: 90 }, phone)).toBe(366);
  });
});
