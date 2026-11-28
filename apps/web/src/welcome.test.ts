import { describe, expect, it } from "vitest";
import { welcomeAllowed } from "./welcome.js";

const device = (matches: string[]) => (query: string) => matches.includes(query);

describe("the welcome", () => {
  it("plays on a computer and never on the phone or the installed app", () => {
    expect(welcomeAllowed(device(["(pointer: fine)", "(hover: hover)"]))).toBe(true);
    expect(welcomeAllowed(device(["(pointer: coarse)"]))).toBe(false);
    expect(welcomeAllowed(device(["(pointer: fine)", "(hover: hover)", "(display-mode: standalone)"]))).toBe(false);
  });
});
