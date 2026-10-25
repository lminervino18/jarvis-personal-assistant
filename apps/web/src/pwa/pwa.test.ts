import { describe, expect, it } from "vitest";
import { isIos, shouldShowInstallHint } from "./platform.js";
import { urlBase64ToBytes } from "./push.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

describe("install hint", () => {
  it("shows only on iPhone and iPad when not installed and not dismissed", () => {
    expect(shouldShowInstallHint({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false }, false)).toBe(true);
    expect(shouldShowInstallHint({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true }, false)).toBe(false);
    expect(shouldShowInstallHint({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false }, true)).toBe(false);
    expect(shouldShowInstallHint({ userAgent: ANDROID, maxTouchPoints: 5, standalone: false }, false)).toBe(false);
  });

  it("recognizes iPadOS reporting a Mac user agent but not a real Mac", () => {
    expect(isIos({ userAgent: MAC, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false);
  });
});

describe("VAPID key decoding", () => {
  it("decodes URL-safe base64 with and without padding", () => {
    expect(Array.from(urlBase64ToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes("-_8"))).toEqual([251, 255]);
  });
});
