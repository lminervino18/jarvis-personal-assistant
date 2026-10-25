import { describe, expect, it } from "vitest";
import { PcmPlayer, type PlaybackBuffer, type PlaybackContext, type PlaybackSource } from "./playback.js";
import { pcm16ToBytes } from "./pcm.js";

class FakeSource implements PlaybackSource {
  buffer: PlaybackBuffer | null = null;
  onended: ((event: Event) => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  disconnected = false;
  connect(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  start(when: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
  finish(): void {
    this.onended?.(new Event("ended"));
  }
}

class FakeContext implements PlaybackContext {
  currentTime = 10;
  sources: FakeSource[] = [];
  buffers: { length: number; sampleRate: number }[] = [];

  createBuffer(_channels: number, length: number, sampleRate: number): PlaybackBuffer {
    this.buffers.push({ length, sampleRate });
    return { duration: length / sampleRate, copyToChannel: () => {} };
  }

  createBufferSource(): PlaybackSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

const TURN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const RATE = 24000;

function chunk(ms: number): Uint8Array {
  return pcm16ToBytes(new Int16Array((RATE * ms) / 1000).fill(1000));
}

function setup(leadSeconds = 0.1) {
  const context = new FakeContext();
  const firstAudio: [string, number][] = [];
  const drained: string[] = [];
  const player = new PcmPlayer(context, {}, {
    leadSeconds,
    onFirstAudio: (turnId, startsAt) => firstAudio.push([turnId, startsAt]),
    onDrained: (turnId) => drained.push(turnId),
  });
  return { context, player, firstAudio, drained };
}

describe("PcmPlayer", () => {
  it("schedules chunks back to back after the lead time", () => {
    const { context, player, firstAudio } = setup();
    player.begin(TURN, RATE);
    player.enqueue(TURN, chunk(100));
    player.enqueue(TURN, chunk(100));
    player.enqueue(TURN, chunk(50));
    const starts = context.sources.map((s) => s.startedAt as number);
    expect(starts[0]).toBeCloseTo(10.1);
    expect(starts[1]).toBeCloseTo(10.2);
    expect(starts[2]).toBeCloseTo(10.3);
    expect(firstAudio).toEqual([[TURN, starts[0]]]);
  });

  it("adds the lead again after an underrun", () => {
    const { context, player } = setup();
    player.begin(TURN, RATE);
    player.enqueue(TURN, chunk(100));
    context.currentTime = 11;
    player.enqueue(TURN, chunk(100));
    expect(context.sources[1]?.startedAt).toBeCloseTo(11.1);
  });

  it("joins samples split across chunk boundaries", () => {
    const { context, player } = setup();
    player.begin(TURN, RATE);
    const bytes = chunk(20);
    player.enqueue(TURN, bytes.subarray(0, 101));
    player.enqueue(TURN, bytes.subarray(101));
    const total = context.buffers.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(bytes.byteLength / 2);
  });

  it("drops chunks of any turn that is not the current one", () => {
    const { context, player } = setup();
    player.begin(TURN, RATE);
    player.enqueue(OTHER, chunk(100));
    expect(context.sources).toHaveLength(0);
  });

  it("drains only after the end marker and every scheduled chunk finished", () => {
    const { context, player, drained } = setup();
    player.begin(TURN, RATE);
    player.enqueue(TURN, chunk(100));
    player.enqueue(TURN, chunk(100));
    player.end(TURN);
    expect(drained).toEqual([]);
    context.sources[0]?.finish();
    expect(drained).toEqual([]);
    context.sources[1]?.finish();
    expect(drained).toEqual([TURN]);
    expect(player.active).toBe(false);
  });

  it("drains immediately when the turn ends without audio", () => {
    const { player, drained } = setup();
    player.begin(TURN, RATE);
    player.end(TURN);
    expect(drained).toEqual([TURN]);
  });

  it("silences everything on stop and never reports a drain for the cut turn", () => {
    const { context, player, drained } = setup();
    player.begin(TURN, RATE);
    player.enqueue(TURN, chunk(100));
    player.enqueue(TURN, chunk(100));
    player.stop();
    expect(context.sources.every((s) => s.stopped && s.disconnected)).toBe(true);
    context.sources[0]?.finish();
    player.end(TURN);
    expect(drained).toEqual([]);
    expect(player.turnId).toBeNull();
    player.enqueue(TURN, chunk(100));
    expect(context.sources).toHaveLength(2);
  });

  it("switches turns without mixing audio", () => {
    const { context, player } = setup();
    player.begin(TURN, RATE);
    player.enqueue(TURN, chunk(100));
    player.begin(OTHER, RATE);
    expect(context.sources[0]?.stopped).toBe(true);
    player.enqueue(TURN, chunk(100));
    player.enqueue(OTHER, chunk(100));
    expect(context.sources).toHaveLength(2);
    expect(player.turnId).toBe(OTHER);
  });
});
