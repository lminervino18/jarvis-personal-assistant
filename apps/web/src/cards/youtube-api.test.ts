import { describe, expect, it } from "vitest";
import { playerStatusLabel, statusFromYtState, type PlayerStatus } from "./youtube-api.js";

describe("YouTube player status", () => {
  it("only reports playing for the playing state", () => {
    expect(statusFromYtState(1)).toBe("playing");
    for (const code of [-1, 0, 2, 3, 5]) expect(statusFromYtState(code)).not.toBe("playing");
    expect(statusFromYtState(0)).toBe("ended");
    expect(statusFromYtState(5)).toBe("ready");
    expect(statusFromYtState(99)).toBeNull();
  });

  it("never claims playback unless the status is playing", () => {
    const statuses: PlayerStatus[] = ["loading", "ready", "buffering", "playing", "paused", "ended", "blocked", "error"];
    const claiming = statuses.filter((s) => playerStatusLabel(s).toLowerCase().startsWith("reproduciendo"));
    expect(claiming).toEqual(["playing"]);
  });
});
