import { describe, expect, it } from "vitest";
import { pinnedAfterScroll, startsFresh } from "./hooks.js";

describe("following the end of the chat", () => {
  it("lets go as soon as the reader scrolls up, even a little, while a reply streams in", () => {
    expect(pinnedAfterScroll(true, 980, 1000, 30)).toBe(true);
    expect(pinnedAfterScroll(true, 900, 920, 120)).toBe(false);
  });

  it("keeps following while the content grows or a scroll moves down towards the end", () => {
    expect(pinnedAfterScroll(true, 1000, 1000, 400)).toBe(true);
    expect(pinnedAfterScroll(true, 1200, 1000, 300)).toBe(true);
  });

  it("follows again once the reader is back near the end, and not before", () => {
    expect(pinnedAfterScroll(false, 1500, 1200, 500)).toBe(false);
    expect(pinnedAfterScroll(false, 1950, 1500, 40)).toBe(true);
  });
});

describe("starting on the greeting when the owner comes back", () => {
  const minute = 60_000;

  it("starts fresh after ten minutes away, not after a quick look at another app", () => {
    expect(startsFresh(1000, 1000 + 10 * minute, 0, false)).toBe(true);
    expect(startsFresh(1000, 1000 + 2 * minute, 0, false)).toBe(false);
  });

  it("keeps the conversation when a notification brought the owner back or a call is going on", () => {
    const now = 1000 + 30 * minute;
    expect(startsFresh(1000, now, now - 1000, false)).toBe(false);
    expect(startsFresh(1000, now, 0, true)).toBe(false);
  });

  it("does nothing before the app was ever hidden", () => {
    expect(startsFresh(0, 30 * minute, 0, false)).toBe(false);
  });
});
