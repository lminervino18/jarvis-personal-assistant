import { BinaryFrameKind, decodeAudioFrame, encodeAudioFrame } from "@jarvis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicError, type AudioEngine } from "../audio/engine.js";
import { pcm16ToBytes } from "../audio/pcm.js";
import { PcmPlayer, type PcmPlayerOptions } from "../audio/playback.js";
import { FakePlaybackContext } from "../audio/testing.js";
import type { TransportHandlers } from "../protocol/client.js";
import { Session, type SessionDeps } from "./session.js";

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeSocket {
  sent: (string | Uint8Array)[] = [];
  seq = 0;
  constructor(readonly handlers: TransportHandlers) {}

  json(): { type: string; [key: string]: unknown }[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }

  last(type: string): { [key: string]: unknown } | undefined {
    return this.json().filter((m) => m.type === type).at(-1);
  }

  binaryFrames(): ReturnType<typeof decodeAudioFrame>[] {
    return this.sent.filter((s): s is Uint8Array => typeof s !== "string").map((s) => decodeAudioFrame(s));
  }

  server(message: object): void {
    this.handlers.text(JSON.stringify({ ...message, seq: ++this.seq }));
  }
}

class FakeEngine implements AudioEngine {
  readonly context = new FakePlaybackContext();
  readonly player: PcmPlayer;
  running = true;
  frames: ((pcm: Int16Array) => void) | null = null;
  micError: Error | null = null;
  listener: () => void = () => {};

  constructor(options: PcmPlayerOptions) {
    this.player = new PcmPlayer(this.context, {}, options);
  }

  get currentTime(): number {
    return this.context.currentTime;
  }

  async resume(): Promise<void> {
    this.running = true;
  }

  outputLevel(): number {
    return 0;
  }

  async startMicrophone(onFrame: (pcm: Int16Array) => void): Promise<void> {
    if (this.micError) throw this.micError;
    this.frames = onFrame;
  }

  stopMicrophone(): void {
    this.frames = null;
  }

  onRunningChange(listener: () => void): void {
    this.listener = listener;
  }

  feed(amplitude: number, count: number): void {
    const frame = new Int16Array(320).fill(Math.round(amplitude * 32767));
    for (let i = 0; i < count; i++) this.frames?.(frame);
  }
}

function readyMessage(voice: boolean, followUpWindowMs = 12_000) {
  return {
    type: "ready",
    protocol: 1,
    conversationId: CONVERSATION,
    owner: { displayName: "Test" },
    capabilities: {
      stt: voice,
      tts: voice,
      ttsProvider: voice ? "fake" : null,
      outputFormat: voice ? { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } : null,
      followUpWindowMs,
      pushPublicKey: null,
    },
  };
}

function setup(overrides: Partial<SessionDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const engines: FakeEngine[] = [];
  let ids = 0;
  let clock = 0;
  const session = new Session({
    url: "ws://test/ws",
    transport: (_url, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return { send: (data) => socket.sent.push(data), close: () => {} };
    },
    createEngine: (options) => {
      const engine = new FakeEngine(options);
      engines.push(engine);
      return engine;
    },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    now: () => clock,
    ...overrides,
  });
  const socket = () => sockets.at(-1) as FakeSocket;
  const engine = () => engines[0] as FakeEngine;
  const connect = (voice = false, followUpWindowMs = 12_000) => {
    session.start();
    socket().handlers.open();
    socket().server(readyMessage(voice, followUpWindowMs));
    socket().server({ type: "history", conversationId: CONVERSATION, items: [], hasMore: false });
    socket().server({ type: "state", state: "idle" });
  };
  return { session, socket, engine, connect, advance: (ms: number) => void (clock += ms) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Session text turns", () => {
  it("goes from connecting to idle with the owner's data", () => {
    const { session, connect } = setup();
    expect(session.getSnapshot().state).toBe("offline");
    connect();
    expect(session.getSnapshot()).toMatchObject({ state: "idle", ownerName: "Test", connection: "ready" });
  });

  it("sends the text, follows the server states and reports first text latency", () => {
    const { session, socket, connect, advance } = setup();
    connect();
    expect(session.sendText("  hola  ")).toBe(true);
    expect(socket().last("user.text")).toMatchObject({ text: "hola", replyMode: "text", conversationId: CONVERSATION });
    const turnId = socket().last("user.text")?.turnId as string;
    expect(session.getSnapshot()).toMatchObject({ state: "thinking", busy: true });
    expect(session.getSnapshot().thread.messages[0]).toMatchObject({ role: "user", text: "hola" });

    socket().server({ type: "state", state: "using_tool", turnId, tool: "agenda" });
    expect(session.getSnapshot().state).toBe("using_tool");
    advance(850);
    socket().server({ type: "assistant.delta", turnId, text: "Buenas" });
    socket().server({ type: "assistant.done", turnId, messageId: "m1", text: "Buenas", interrupted: false });
    socket().server({ type: "turn.end", turnId, status: "completed" });
    socket().server({ type: "state", state: "idle" });
    expect(session.getSnapshot()).toMatchObject({ state: "idle", busy: false });
    expect(socket().last("client.metrics")).toEqual({ type: "client.metrics", turnId, firstTextMs: 850 });
  });

  it("refuses to send while offline and keeps the notice", () => {
    const { session } = setup();
    expect(session.sendText("hola")).toBe(false);
    expect(session.getSnapshot().notice?.level).toBe("warning");
    expect(session.sendText("   ")).toBe(false);
  });

  it("cuts the running turn from the stop button", () => {
    const { session, socket, connect } = setup();
    connect();
    session.sendText("contame algo largo");
    const turnId = socket().last("user.text")?.turnId;
    session.stopAll();
    expect(socket().last("turn.cancel")).toEqual({ type: "turn.cancel", turnId, reason: "user_stop" });
    expect(session.getSnapshot().state).toBe("idle");
  });

  it("falls back to offline when the socket drops", () => {
    const { session, socket, connect } = setup();
    connect();
    session.sendText("hola");
    socket().handlers.close(1006);
    expect(session.getSnapshot()).toMatchObject({ state: "offline", busy: false });
  });

  it("asks for a new login when the session expired", async () => {
    const { session, socket, connect } = setup({ isSessionValid: async () => false });
    connect();
    socket().handlers.close(4001);
    await vi.advanceTimersByTimeAsync(10);
    expect(session.getSnapshot().needsLogin).toBe(true);
  });

  it("applies player commands that arrive before the card is mounted", () => {
    const { session, socket, connect } = setup();
    connect();
    const calls: string[] = [];
    socket().server({ type: "player.command", requestId: "r1", action: "play" });
    session.registerPlayer("r1", { play: () => calls.push("play"), pause: () => calls.push("pause") });
    socket().server({ type: "player.command", requestId: "r1", action: "pause" });
    expect(calls).toEqual(["play", "pause"]);
    session.reportPlayer("r1", "dQw4w9WgXcQ", "playing");
    expect(socket().last("player.state")).toMatchObject({ requestId: "r1", state: "playing" });
  });
});

describe("Session voice turns", () => {
  it("degrades to text when the server has no speech-to-text", async () => {
    const { session, connect, engine } = setup();
    connect();
    await session.toggleMicrophone();
    expect(session.getSnapshot()).toMatchObject({ micOpen: false });
    expect(session.getSnapshot().notice?.text).toContain("voz");
    expect(engine()).toBeUndefined();
  });

  it("reports a denied microphone without opening it", async () => {
    const { session, connect, engine } = setup();
    connect(true);
    await session.toggleMicrophone();
    await session.toggleMicrophone();
    engine().micError = new MicError("denied");
    await session.toggleMicrophone();
    expect(session.getSnapshot().micOpen).toBe(false);
    expect(session.getSnapshot().notice?.text).toContain("permiso");
  });

  it("captures an utterance, sends it, plays the reply and keeps listening for a follow-up", async () => {
    const { session, socket, engine, connect, advance } = setup();
    connect(true);
    await session.toggleMicrophone();
    expect(session.getSnapshot()).toMatchObject({ micOpen: true, state: "listening" });

    engine().feed(0.0008, 40);
    engine().feed(0.1, 25);
    const begin = socket().last("audio.begin");
    expect(begin).toMatchObject({ replyMode: "voice", format: { sampleRate: 16000 } });
    const turnId = begin?.turnId as string;
    expect(session.getSnapshot().state).toBe("listening");
    expect(socket().binaryFrames().every((f) => f.kind === BinaryFrameKind.micAudio && f.turnId === turnId)).toBe(true);
    expect(socket().binaryFrames().length).toBeGreaterThanOrEqual(25);

    advance(1000);
    engine().feed(0.0008, 60);
    expect(socket().last("audio.end")).toEqual({ type: "audio.end", turnId });
    expect(session.getSnapshot().state).toBe("transcribing");

    socket().server({ type: "transcript", turnId, text: "qué hora es", final: true });
    socket().server({ type: "state", state: "thinking", turnId });
    advance(1500);
    socket().server({ type: "audio.begin", turnId, format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 }, processed: false });
    socket().server({ type: "state", state: "speaking", turnId });
    socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, pcm16ToBytes(new Int16Array(2400).fill(500))));
    expect(session.getSnapshot().state).toBe("speaking");
    expect(engine().context.sources).toHaveLength(1);

    socket().server({ type: "audio.end", turnId, reason: "complete" });
    socket().server({ type: "turn.end", turnId, status: "completed" });
    socket().server({ type: "state", state: "idle" });
    expect(session.getSnapshot().state).toBe("speaking");
    engine().context.sources[0]?.finish();
    expect(session.getSnapshot().state).toBe("listening");
    const metrics = socket().last("client.metrics");
    expect(metrics?.turnId).toBe(turnId);
    expect(metrics?.firstAudioMs).toBe(1620);

    vi.advanceTimersByTime(11_999);
    expect(session.getSnapshot().micOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(session.getSnapshot()).toMatchObject({ micOpen: false, state: "idle" });
    expect(engine().frames).toBeNull();
  });

  it("drops speech frames of a turn the owner cut", async () => {
    const { session, socket, engine, connect } = setup();
    connect(true);
    await session.toggleMicrophone();
    session.sendText("hablame");
    const turnId = socket().last("user.text")?.turnId as string;
    socket().server({ type: "audio.begin", turnId, format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 }, processed: false });
    socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, pcm16ToBytes(new Int16Array(2400))));
    expect(engine().context.sources).toHaveLength(1);

    session.stopAll();
    expect(engine().context.sources[0]?.stopped).toBe(true);
    expect(engine().frames).toBeNull();
    socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, pcm16ToBytes(new Int16Array(2400))));
    expect(engine().context.sources).toHaveLength(1);
    expect(session.getSnapshot().micOpen).toBe(false);
  });

  it("interrupts the reply when the owner speaks over it", async () => {
    const { session, socket, engine, connect } = setup();
    connect(true);
    await session.toggleMicrophone();
    engine().feed(0.0008, 40);
    session.sendText("contame un cuento");
    const turnId = socket().last("user.text")?.turnId as string;
    socket().server({ type: "state", state: "speaking", turnId });
    socket().server({ type: "audio.begin", turnId, format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 }, processed: false });
    socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, pcm16ToBytes(new Int16Array(24000))));

    engine().feed(0.0008, 30);
    engine().feed(0.5, 30);
    expect(socket().last("turn.cancel")).toMatchObject({ turnId, reason: "barge_in" });
    expect(engine().context.sources[0]?.stopped).toBe(true);
    expect(socket().last("audio.begin")?.turnId).not.toBe(turnId);
    expect(session.getSnapshot().state).toBe("listening");
  });

  it("closes the microphone when the conversation ends", async () => {
    const { session, socket, connect } = setup();
    connect(true);
    await session.toggleMicrophone();
    socket().server({ type: "conversation.end", conversationId: CONVERSATION, reason: "farewell" });
    expect(session.getSnapshot().micOpen).toBe(false);
  });
});
