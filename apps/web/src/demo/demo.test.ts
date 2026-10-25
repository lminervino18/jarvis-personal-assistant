import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "../conversation/session.js";
import { demoTransport } from "./demo-server.js";

function demoSession() {
  return new Session({
    url: "ws://demo",
    transport: demoTransport({ stepMs: 10, now: () => new Date("2026-10-24T15:00:00.000Z") }),
    createEngine: () => {
      throw new Error("the demo has no audio");
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("demo mode", () => {
  it("opens a fictitious conversation without a backend", async () => {
    const session = demoSession();
    session.start();
    await vi.advanceTimersByTimeAsync(5);
    const snapshot = session.getSnapshot();
    expect(snapshot).toMatchObject({ state: "idle", ownerName: "Demo", connection: "ready" });
    expect(snapshot.thread.messages.length).toBeGreaterThanOrEqual(4);
    expect(snapshot.capabilities).toMatchObject({ stt: false, tts: false });
    session.stop();
  });

  it("answers with real state transitions and a card, and resolves confirmations", async () => {
    const session = demoSession();
    session.start();
    await vi.advanceTimersByTimeAsync(5);
    session.sendText("mandá un correo a Ana");
    const states = new Set<string>([session.getSnapshot().state]);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10);
      states.add(session.getSnapshot().state);
    }
    expect([...states]).toEqual(expect.arrayContaining(["thinking", "using_tool", "idle"]));
    const last = session.getSnapshot().thread.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.cards[0]).toMatchObject({ kind: "confirm", status: "pending" });

    session.decide("demo-action", "confirm");
    await vi.advanceTimersByTimeAsync(1);
    const decided = session.getSnapshot().thread.messages.find((m) => m.cards.some((c) => c.kind === "confirm"));
    expect(decided?.cards.find((c) => c.kind === "confirm")).toMatchObject({ status: "confirmed" });
    session.stop();
  });

  it("starts an empty conversation on request", async () => {
    const session = demoSession();
    session.start();
    await vi.advanceTimersByTimeAsync(5);
    session.newConversation();
    await vi.advanceTimersByTimeAsync(5);
    expect(session.getSnapshot().thread.messages).toEqual([]);
    session.stop();
  });
});
