import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechVad, playbackSpeechVadOptions, speechVadOptions } from "./speech-vad.js";
import { VoiceLoop, type DetectorFactory, type VoiceLoopHandlers } from "./voice-loop.js";

const FRAME_SAMPLES = 320;

function frame(amplitude: number): Int16Array {
  return new Int16Array(FRAME_SAMPLES).fill(Math.round(amplitude * 32767));
}

const QUIET = frame(0.0008);
const SPEECH = frame(0.1);

/** A detector driven by the probability written in each test frame, standing in for Silero. */
const probabilityDetectors: DetectorFactory = (playing) => {
  const vad = new SpeechVad(playing ? playbackSpeechVadOptions : speechVadOptions);
  return {
    push: (pcm) => vad.push((pcm[0] ?? 0) / 1000),
    reset: () => vad.reset(),
    get voicedMs() {
      return vad.voicedTotalMs;
    },
  };
};

function probability(value: number): Int16Array {
  return new Int16Array(FRAME_SAMPLES).fill(Math.round(value * 1000));
}

function harness(accept = true, detectors?: DetectorFactory) {
  const events: string[] = [];
  const frames: Int16Array[] = [];
  const handlers: VoiceLoopHandlers = {
    onStart: (duringPlayback) => {
      events.push(duringPlayback ? "start-over-reply" : "start");
      return accept;
    },
    onFrame: (pcm) => frames.push(pcm),
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
    onConfirmed: () => events.push("confirmed"),
    onEnd: () => events.push("end"),
    onLevel: () => {},
    onTimeout: () => events.push("timeout"),
  };
  const loop = new VoiceLoop(handlers, detectors);
  const feed = (pcm: Int16Array, count: number) => {
    for (let i = 0; i < count; i++) loop.push(pcm);
  };
  return { loop, events, frames, feed };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceLoop", () => {
  it("starts an utterance with pre-roll, streams it and ends after the silence window", () => {
    const { loop, events, frames, feed } = harness();
    feed(QUIET, 40);
    feed(SPEECH, 20);
    expect(events).toEqual(["start"]);
    expect(loop.capturing).toBe(true);
    const sentBeforeEnd = frames.length;
    expect(sentBeforeEnd).toBeGreaterThanOrEqual(8);
    feed(QUIET, 60);
    expect(events).toEqual(["start", "end"]);
    expect(loop.capturing).toBe(false);
    expect(frames.length).toBeGreaterThan(sentBeforeEnd);
    expect(frames.filter((f) => f === QUIET).length).toBeGreaterThan(0);
  });

  it("includes the voiced frames that preceded confirmation", () => {
    const { frames, feed } = harness();
    feed(QUIET, 40);
    feed(SPEECH, 8);
    expect(frames.filter((f) => f === SPEECH).length).toBe(8);
  });

  it("does not start when the owner rejects the turn", () => {
    const { loop, events, frames, feed } = harness(false);
    feed(QUIET, 40);
    feed(SPEECH, 10);
    expect(events[0]).toBe("start");
    expect(loop.capturing).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("fires the timeout when no speech comes within the window and not after speech starts", () => {
    const { loop, events, feed } = harness();
    loop.startWindow(12_000);
    vi.advanceTimersByTime(11_999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["timeout"]);

    loop.startWindow(12_000);
    feed(QUIET, 40);
    feed(SPEECH, 20);
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual(["timeout", "start"]);
  });

  it("cancel drops the utterance without reporting an end", () => {
    const { loop, events, feed } = harness();
    feed(QUIET, 40);
    feed(SPEECH, 20);
    loop.cancel();
    feed(QUIET, 80);
    expect(events).toEqual(["start"]);
    expect(loop.capturing).toBe(false);
  });

  it("is harder to trigger while the assistant is speaking", () => {
    const { loop, events, feed } = harness();
    const echo = frame(0.02);
    feed(QUIET, 40);
    loop.setPlaying(true);
    feed(echo, 100);
    feed(frame(0.6), 20);
    expect(events).toEqual(["start-over-reply"]);

    const second = harness();
    second.feed(QUIET, 40);
    second.loop.setPlaying(true);
    second.feed(echo, 100);
    expect(second.events).toEqual([]);
  });

  it("reports pauses and resumes inside one utterance instead of ending it at a short silence", () => {
    const { events, feed } = harness(true, probabilityDetectors);
    feed(probability(0.9), 20);
    feed(probability(0.05), 25);
    feed(probability(0.9), 10);
    feed(probability(0.05), 25);
    expect(events).toEqual(["start", "pause", "resume", "pause"]);
    feed(probability(0.05), 160);
    expect(events.at(-1)).toBe("end");
  });

  it("treats speech over the reply as a candidate and confirms it only when it lasts", () => {
    const { loop, events, feed } = harness(true, probabilityDetectors);
    loop.setPlaying(true);
    feed(probability(0.9), 15);
    expect(events).toEqual(["start-over-reply"]);
    feed(probability(0.05), 25);
    expect(events).toEqual(["start-over-reply", "pause"]);
    loop.cancel();
    feed(probability(0.9), 40);
    expect(events).toEqual(["start-over-reply", "pause", "start-over-reply", "confirmed"]);
  });

  it("ignores a short noise below the speech probability", () => {
    const { events, feed } = harness(true, probabilityDetectors);
    feed(probability(0.3), 50);
    feed(probability(0.9), 5);
    feed(probability(0.05), 10);
    expect(events).toEqual([]);
  });
});
