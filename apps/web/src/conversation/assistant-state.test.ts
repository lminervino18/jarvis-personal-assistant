import { assistantStates, type AssistantState } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { deriveState, isBusy, stateLabel, type StateFacts } from "./assistant-state.js";

const base: StateFacts = { connection: "ready", server: "idle", capturing: false, micOpen: false, playing: false };

describe("deriveState", () => {
  it("reports the connection before anything else", () => {
    expect(deriveState({ ...base, connection: "connecting", capturing: true })).toBe("connecting");
    expect(deriveState({ ...base, connection: "offline", playing: true })).toBe("offline");
    expect(deriveState({ ...base, connection: "closed" })).toBe("offline");
  });

  it("uses the server state when the device has nothing to add", () => {
    for (const server of ["transcribing", "thinking", "using_tool", "speaking", "interrupted", "error"] as const) {
      expect(deriveState({ ...base, server })).toBe(server);
    }
  });

  it("shows listening only for a real capture or an open microphone while idle", () => {
    expect(deriveState({ ...base, capturing: true, server: "thinking" })).toBe("listening");
    expect(deriveState({ ...base, micOpen: true })).toBe("listening");
    expect(deriveState({ ...base, micOpen: true, server: "thinking" })).toBe("thinking");
  });

  it("keeps speaking while buffered audio plays after the server finished", () => {
    expect(deriveState({ ...base, playing: true })).toBe("speaking");
    expect(deriveState({ ...base, playing: true, micOpen: true })).toBe("speaking");
  });

  it("returns to idle when nothing is happening", () => {
    expect(deriveState(base)).toBe("idle");
  });
});

describe("labels and busy", () => {
  it("has a Spanish label for every state", () => {
    for (const state of assistantStates) expect(stateLabel(state).length).toBeGreaterThan(0);
  });

  it("is busy while a turn runs or the microphone captures", () => {
    const busy = assistantStates.filter((s: AssistantState) => isBusy(s, false));
    expect(busy).toEqual(["transcribing", "thinking", "using_tool", "speaking"]);
    expect(isBusy("idle", true)).toBe(true);
  });
});
