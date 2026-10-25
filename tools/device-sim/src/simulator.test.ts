import { randomUUID } from "node:crypto";
import { BinaryFrameKind, decodeAudioFrame, encodeAudioFrame } from "@jarvis/contracts";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_AUDIO_FORMAT, DeviceSimulator, type SimulatorOptions } from "./simulator.js";
import { toneAudio } from "./wav.js";

const CONVERSATION_ID = randomUUID();
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class FakeServer {
  readonly clients: WebSocket[] = [];
  readonly headers: Record<string, string | string[] | undefined>[] = [];
  readonly texts: Record<string, unknown>[] = [];
  readonly micFrames: { turnId: string; bytes: number }[] = [];
  private seq = 0;
  private readonly wss: WebSocketServer;

  static async start(options: { reject?: boolean } = {}): Promise<FakeServer> {
    const server = new FakeServer(options);
    await new Promise<void>((resolve) => server.wss.once("listening", resolve));
    return server;
  }

  private constructor(options: { reject?: boolean }) {
    this.wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: (info, done) => (options.reject ? done(false, 401, "Unauthorized") : done(true)),
    });
    this.wss.on("connection", (socket, request) => {
      this.clients.push(socket);
      this.headers.push(request.headers);
      socket.on("message", (data, isBinary) => this.onMessage(socket, data as Buffer, isBinary));
    });
    cleanups.push(() => this.wss.close());
  }

  get url(): string {
    const address = this.wss.address();
    return `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/ws/device`;
  }

  send(message: Record<string, unknown>, socket = this.clients.at(-1)): void {
    socket?.send(JSON.stringify({ ...message, seq: ++this.seq }));
  }

  sendTts(turnId: string, bytes: number, socket = this.clients.at(-1)): void {
    socket?.send(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, new Uint8Array(bytes).fill(1)));
  }

  async waitFor<T>(find: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = find();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timeout");
  }

  waitForText(type: string, nth = 0): Promise<Record<string, unknown>> {
    return this.waitFor(() => this.texts.filter((m) => m.type === type)[nth]);
  }

  private onMessage(socket: WebSocket, data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const frame = decodeAudioFrame(new Uint8Array(data));
      this.micFrames.push({ turnId: frame.turnId, bytes: frame.payload.byteLength });
      return;
    }
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    this.texts.push(message);
    if (message.type === "hello") {
      this.send(
        {
          type: "ready",
          protocol: 1,
          conversationId: CONVERSATION_ID,
          owner: { displayName: "Alex" },
          capabilities: { stt: true, tts: true, ttsProvider: "fake", outputFormat: DEVICE_AUDIO_FORMAT, followUpWindowMs: 0, pushPublicKey: null },
        },
        socket,
      );
    }
  }
}

async function connected(server: FakeServer, options: Partial<SimulatorOptions> = {}) {
  const simulator = new DeviceSimulator({ url: server.url, token: "secret-token", reconnect: { minDelayMs: 10, maxDelayMs: 40 }, ...options });
  cleanups.push(() => simulator.close());
  await simulator.connect(2000);
  return simulator;
}

describe("DeviceSimulator", () => {
  it("refuses to send the token over plain ws:// to a remote host", () => {
    expect(() => new DeviceSimulator({ url: "ws://jarvis.example.com/ws/device", token: "t" })).toThrow("wss://");
    expect(() => new DeviceSimulator({ url: "http://jarvis.example.com/ws/device", token: "t" })).toThrow("wss://");
    expect(() => new DeviceSimulator({ url: "ws://jarvis.example.com/ws/device", token: "t", allowInsecure: true })).not.toThrow();
  });

  it("authenticates with the bearer header, negotiates 16 kHz PCM and streams tagged frames", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    expect(server.headers[0]?.authorization).toBe("Bearer secret-token");
    expect(server.headers[0]?.cookie).toBeUndefined();
    expect(await server.waitForText("hello")).toMatchObject({
      protocol: 1,
      client: { kind: "simulator" },
      audio: { input: [DEVICE_AUDIO_FORMAT], output: [DEVICE_AUDIO_FORMAT] },
    });

    const pcm = toneAudio(0.5, 16000);
    const { turnId } = simulator.speak(pcm);
    const begin = await server.waitForText("audio.begin");
    expect(begin).toMatchObject({ turnId, conversationId: CONVERSATION_ID, replyMode: "voice", format: DEVICE_AUDIO_FORMAT });
    await server.waitForText("audio.end");
    expect(server.micFrames.every((frame) => frame.turnId === turnId && frame.bytes <= 640)).toBe(true);
    expect(server.micFrames.reduce((sum, frame) => sum + frame.bytes, 0)).toBe(pcm.byteLength);
  });

  it("collects the reply of a completed turn", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    const { turnId, done } = simulator.speak(toneAudio(0.1, 16000));
    await server.waitForText("audio.end");
    server.send({ type: "transcript", turnId, text: "hola", final: true });
    server.send({ type: "audio.begin", turnId, format: DEVICE_AUDIO_FORMAT, processed: true });
    server.sendTts(turnId, 640);
    server.sendTts(turnId, 640);
    server.send({ type: "assistant.done", turnId, messageId: "m1", text: "Hola.", interrupted: false });
    server.send({ type: "audio.end", turnId, reason: "complete" });
    server.send({ type: "turn.end", turnId, status: "completed" });
    const result = await done;
    expect(result).toMatchObject({ status: "completed", transcript: "hola", assistantText: "Hola.", replyTruncated: false });
    expect(result.reply.byteLength).toBe(1280);
  });

  it("discards the reply and drops late frames of a cancelled turn", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    const { turnId, done } = simulator.speak(toneAudio(0.1, 16000));
    await server.waitForText("audio.end");
    server.send({ type: "audio.begin", turnId, format: DEVICE_AUDIO_FORMAT, processed: true });
    server.sendTts(turnId, 640);
    await new Promise((resolve) => setTimeout(resolve, 30));

    simulator.cancel("barge_in");
    expect(await server.waitForText("turn.cancel")).toMatchObject({ turnId, reason: "barge_in" });
    server.sendTts(turnId, 640);
    server.send({ type: "audio.end", turnId, reason: "cancelled" });
    server.send({ type: "turn.end", turnId, status: "cancelled" });
    const result = await done;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.status).toBe("cancelled");
    expect(result.reply.byteLength).toBe(0);
    expect(simulator.stats.droppedFrames).toBe(1);
  });

  it("drops frames that belong to another turn and frames after audio.end", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    const { turnId, done } = simulator.speak(toneAudio(0.1, 16000));
    await server.waitForText("audio.end");
    server.send({ type: "audio.begin", turnId, format: DEVICE_AUDIO_FORMAT, processed: true });
    server.sendTts(randomUUID(), 640);
    server.sendTts(turnId, 640);
    server.send({ type: "audio.end", turnId, reason: "complete" });
    server.sendTts(turnId, 640);
    server.send({ type: "turn.end", turnId, status: "completed" });
    const result = await done;
    expect(result.reply.byteLength).toBe(640);
    expect(simulator.stats.droppedFrames).toBe(2);
  });

  it("keeps the reply buffer bounded", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server, { maxReplyBytes: 1000 });
    const { turnId, done } = simulator.speak(toneAudio(0.1, 16000));
    await server.waitForText("audio.end");
    server.send({ type: "audio.begin", turnId, format: DEVICE_AUDIO_FORMAT, processed: true });
    for (let i = 0; i < 5; i++) server.sendTts(turnId, 640);
    server.send({ type: "audio.end", turnId, reason: "complete" });
    server.send({ type: "turn.end", turnId, status: "completed" });
    const result = await done;
    expect(result.reply.byteLength).toBe(640);
    expect(result.replyTruncated).toBe(true);
  });

  it("stops streaming the microphone as soon as the turn is cancelled", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    const { done } = simulator.speak(toneAudio(10, 16000));
    await server.waitFor(() => (server.micFrames.length > 0 ? true : undefined));
    simulator.cancel();
    expect((await done).status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const framesAfterCancel = server.micFrames.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.micFrames.length).toBe(framesAfterCancel);
    expect(framesAfterCancel).toBeLessThan(500);
    expect(server.texts.some((m) => m.type === "audio.end")).toBe(false);
  });

  it("reconnects with backoff, resumes the conversation and fails the interrupted turn", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    const { done } = simulator.speak(toneAudio(10, 16000));
    await server.waitFor(() => (server.micFrames.length > 0 ? true : undefined));
    server.clients[0]?.terminate();
    expect((await done).status).toBe("disconnected");

    await server.waitFor(() => (server.clients.length === 2 ? true : undefined));
    await server.waitForText("hello", 1);
    expect(server.texts.filter((m) => m.type === "hello")[1]).toMatchObject({ conversationId: CONVERSATION_ID });
    await server.waitFor(() => (simulator.isReady() ? true : undefined));
    expect(simulator.stats.reconnects).toBe(1);
    expect(server.headers[1]?.authorization).toBe("Bearer secret-token");
  });

  it("does not retry a rejected token", async () => {
    const server = await FakeServer.start({ reject: true });
    const simulator = new DeviceSimulator({ url: server.url, token: "revoked", reconnect: { minDelayMs: 10, maxDelayMs: 20 } });
    cleanups.push(() => simulator.close());
    await expect(simulator.connect(2000)).rejects.toThrow("unauthorized");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(simulator.stats).toMatchObject({ reconnects: 0, fatal: "unauthorized" });
  });

  it("does not retry after the server revokes the device", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    server.clients[0]?.close(4001, "device revoked");
    await server.waitFor(() => (simulator.stats.fatal ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.clients).toHaveLength(1);
  });

  it("fails a turn the server never answers", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server, { turnTimeoutMs: 50 });
    const { done } = simulator.speak(toneAudio(0.1, 16000));
    expect(await done).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(await server.waitForText("turn.cancel")).toBeDefined();
  });

  it("allows one turn at a time", async () => {
    const server = await FakeServer.start();
    const simulator = await connected(server);
    simulator.speak(toneAudio(1, 16000));
    expect(() => simulator.speak(toneAudio(1, 16000))).toThrow("in progress");
  });
});
