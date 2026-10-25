import { BinaryFrameKind, decodeAudioFrame, encodeAudioFrame, type ServerMessage } from "@jarvis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PING_TIMEOUT_CLOSE_CODE,
  ProtocolClient,
  type ConnectionStatus,
  type ProtocolClientOptions,
  type TransportHandlers,
} from "./client.js";

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CONVERSATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN = "11111111-1111-4111-8111-111111111111";
const OTHER_TURN = "22222222-2222-4222-8222-222222222222";

class FakeSocket {
  sent: (string | Uint8Array)[] = [];
  closed: number | undefined;
  constructor(readonly handlers: TransportHandlers) {}

  json(): { type: string; [key: string]: unknown }[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }

  open(): void {
    this.handlers.open();
  }

  serverSends(message: { seq: number; type: string; [key: string]: unknown }): void {
    this.handlers.text(JSON.stringify(message));
  }

  drop(code = 1006): void {
    this.handlers.close(code);
  }
}

function ready(seq: number, conversationId = CONVERSATION): ServerMessage {
  return {
    seq,
    type: "ready",
    protocol: 1,
    conversationId,
    owner: { displayName: "Test" },
    capabilities: { stt: false, tts: false, ttsProvider: null, outputFormat: null, followUpWindowMs: 12000, pushPublicKey: null },
  };
}

function harness(overrides: Partial<ProtocolClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: ServerMessage[] = [];
  const audio: [string, Uint8Array][] = [];
  const client = new ProtocolClient({
    url: "ws://test/ws",
    client: { kind: "web", version: "test" },
    audio: { input: [], output: [{ encoding: "pcm_s16le", sampleRate: 24000, channels: 1 }] },
    random: () => 1,
    transport: (_url, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return { send: (data) => socket.sent.push(data), close: (code) => void (socket.closed = code) };
    },
    onStatus: (status) => statuses.push(status),
    onMessage: (message) => messages.push(message),
    onAudio: (turnId, pcm) => audio.push([turnId, pcm]),
    ...overrides,
  });
  const socket = (index = sockets.length - 1) => sockets[index] as FakeSocket;
  return { client, sockets, socket, statuses, messages, audio };
}

function connect(h: ReturnType<typeof harness>) {
  h.client.start();
  h.socket().open();
  h.socket().serverSends(ready(1));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProtocolClient handshake", () => {
  it("sends hello on open and becomes ready only after the server's ready", () => {
    const h = harness();
    h.client.start();
    expect(h.statuses).toEqual(["connecting"]);
    h.socket().open();
    expect(h.socket().json()).toMatchObject([{ type: "hello", protocol: 1, client: { kind: "web" } }]);
    expect(h.client.send({ type: "ping", t: 1 })).toBe(false);
    h.socket().serverSends(ready(1));
    expect(h.statuses).toEqual(["connecting", "ready"]);
    expect(h.client.conversationId).toBe(CONVERSATION);
    expect(h.client.send({ type: "ping", t: 1 })).toBe(true);
  });

  it("ignores messages with an old or repeated seq and invalid payloads", () => {
    const h = harness();
    connect(h);
    h.socket().serverSends({ seq: 2, type: "pong", t: 5 });
    h.socket().serverSends({ seq: 2, type: "pong", t: 6 });
    h.socket().serverSends({ seq: 1, type: "pong", t: 7 });
    h.socket().handlers.text("not json");
    h.socket().serverSends({ seq: 3, type: "state", state: "bogus" });
    expect(h.messages.map((m) => m.type)).toEqual(["ready", "pong"]);
  });
});

describe("ProtocolClient reconnection", () => {
  it("retries with growing delays and resumes the same conversation", async () => {
    const h = harness({ policy: { initialMs: 500, maxMs: 2000, factor: 2, pingIntervalMs: 25_000, pongTimeoutMs: 10_000 } });
    connect(h);
    h.socket().drop();
    expect(h.client.connectionStatus).toBe("offline");

    await vi.advanceTimersByTimeAsync(499);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sockets).toHaveLength(4);

    h.socket().open();
    expect(h.socket().json()[0]).toMatchObject({ type: "hello", conversationId: CONVERSATION });
  });

  it("restarts seq counting and resets the backoff after a successful ready", async () => {
    const h = harness();
    connect(h);
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(500);
    h.socket().open();
    h.socket().serverSends(ready(1, OTHER_CONVERSATION));
    expect(h.client.conversationId).toBe(OTHER_CONVERSATION);
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(3);
  });

  it("stops when shouldReconnect resolves false", async () => {
    const h = harness({ shouldReconnect: async () => false });
    connect(h);
    h.socket().drop(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.client.connectionStatus).toBe("closed");
  });

  it("does not reconnect after stop and ignores late events from the old socket", async () => {
    const h = harness();
    connect(h);
    const old = h.socket();
    h.client.stop();
    expect(old.closed).toBe(1000);
    old.serverSends({ seq: 2, type: "pong", t: 1 });
    old.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.messages.map((m) => m.type)).toEqual(["ready"]);
  });

  it("retryNow reconnects immediately when down", async () => {
    const h = harness();
    connect(h);
    h.socket().drop();
    h.client.retryNow();
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("drops the connection when pings go unanswered", async () => {
    const h = harness({ policy: { initialMs: 500, maxMs: 500, factor: 1, pingIntervalMs: 1000, pongTimeoutMs: 300 } });
    connect(h);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.socket().json().some((m) => m.type === "ping")).toBe(true);
    const first = h.socket();
    await vi.advanceTimersByTimeAsync(300);
    expect(first.closed).toBe(PING_TIMEOUT_CLOSE_CODE);
    expect(h.client.connectionStatus).toBe("offline");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sockets).toHaveLength(2);
  });

  it("keeps the connection when pongs arrive", async () => {
    const h = harness({ policy: { initialMs: 500, maxMs: 500, factor: 1, pingIntervalMs: 1000, pongTimeoutMs: 300 } });
    connect(h);
    for (let seq = 2; seq < 7; seq++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.socket().serverSends({ seq, type: "pong", t: 1 });
    }
    expect(h.client.connectionStatus).toBe("ready");
    expect(h.sockets).toHaveLength(1);
  });
});

describe("ProtocolClient audio", () => {
  const speech = new Uint8Array([1, 0, 2, 0]);
  const audioBegin = (seq: number, turnId: string) => ({
    seq,
    type: "audio.begin",
    turnId,
    format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
    processed: false,
  });

  it("delivers speech frames only for the current speaking turn", () => {
    const h = harness();
    connect(h);
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, TURN, speech));
    h.socket().serverSends(audioBegin(2, TURN));
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, OTHER_TURN, speech));
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, TURN, speech));
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.micAudio, TURN, speech));
    h.socket().handlers.binary(new Uint8Array([9, 9]));
    expect(h.audio.map(([turnId]) => turnId)).toEqual([TURN]);
    h.socket().serverSends({ seq: 3, type: "audio.end", turnId: TURN, reason: "complete" });
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, TURN, speech));
    expect(h.audio).toHaveLength(1);
  });

  it("switches to the newest turn and refuses a cancelled one", () => {
    const h = harness();
    connect(h);
    h.socket().serverSends(audioBegin(2, TURN));
    h.socket().serverSends(audioBegin(3, OTHER_TURN));
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, TURN, speech));
    expect(h.audio).toHaveLength(0);
    h.client.audioGate.cancel(OTHER_TURN);
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, OTHER_TURN, speech));
    h.socket().serverSends(audioBegin(4, OTHER_TURN));
    h.socket().handlers.binary(encodeAudioFrame(BinaryFrameKind.ttsAudio, OTHER_TURN, speech));
    expect(h.audio).toHaveLength(0);
  });

  it("forgets the speaking turn when the connection drops", () => {
    const h = harness();
    connect(h);
    h.socket().serverSends(audioBegin(2, TURN));
    h.socket().drop();
    expect(h.client.audioGate.speakingTurn).toBeNull();
  });

  it("sends microphone frames tagged with the turn id", () => {
    const h = harness();
    expect(h.client.sendAudio(TURN, speech)).toBe(false);
    connect(h);
    expect(h.client.sendAudio(TURN, speech)).toBe(true);
    const frame = decodeAudioFrame(h.socket().sent.at(-1) as Uint8Array);
    expect(frame).toMatchObject({ kind: BinaryFrameKind.micAudio, turnId: TURN });
    expect(Array.from(frame.payload)).toEqual(Array.from(speech));
  });
});
