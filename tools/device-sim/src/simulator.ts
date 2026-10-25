import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop, setTimeout as sleep } from "node:timers/promises";
import {
  BinaryFrameKind,
  PROTOCOL_VERSION,
  ServerMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioFormat,
} from "@jarvis/contracts";
import WebSocket from "ws";

export const DEVICE_AUDIO_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

const BYTES_PER_SAMPLE = 2;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FATAL_CLOSE_CODE = 4001;

export interface SimulatorOptions {
  url: string;
  token: string;
  version?: string;
  allowInsecure?: boolean;
  frameMs?: number;
  realtime?: boolean;
  maxReplyBytes?: number;
  maxOutboundBufferedBytes?: number;
  heartbeatMs?: number;
  turnTimeoutMs?: number;
  reconnect?: { minDelayMs: number; maxDelayMs: number };
  log?: (line: string) => void;
}

const DEFAULTS = {
  version: "device-sim",
  allowInsecure: false,
  frameMs: 20,
  realtime: false,
  maxReplyBytes: DEVICE_AUDIO_FORMAT.sampleRate * BYTES_PER_SAMPLE * 60,
  maxOutboundBufferedBytes: 32 * 1024,
  heartbeatMs: 15_000,
  turnTimeoutMs: 60_000,
  reconnect: { minDelayMs: 500, maxDelayMs: 30_000 },
  log: (_line: string) => {},
};

export type TurnStatus = "completed" | "cancelled" | "failed" | "disconnected";

export interface TurnResult {
  turnId: string;
  status: TurnStatus;
  errorCode?: string;
  transcript: string;
  assistantText: string;
  reply: Uint8Array;
  replyFormat: AudioFormat | null;
  replyTruncated: boolean;
}

export interface TurnHandle {
  turnId: string;
  done: Promise<TurnResult>;
}

interface ActiveTurn {
  turnId: string;
  transcript: string;
  assistantText: string;
  replyFormat: AudioFormat | null;
  replyChunks: Uint8Array[];
  replyBytes: number;
  replyTruncated: boolean;
  receivingReply: boolean;
  timeout: NodeJS.Timeout;
  resolve(result: TurnResult): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertTransportIsSafe(url: string, allowInsecure: boolean): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === "wss:") return;
  const local = LOCAL_HOSTS.has(hostname) || LOCAL_HOSTS.has(`[${hostname}]`);
  if (protocol !== "ws:" || !(local || allowInsecure)) {
    throw new Error("the device token only travels over wss:// (ws:// is allowed for localhost or with allowInsecure)");
  }
}

/**
 * Behaves like the ATOM Echo firmware at the protocol level: bearer-token WebSocket, 16 kHz PCM in and out,
 * one active turn, frames of any other turn discarded, bounded buffers and reconnection with backoff.
 * It does not exercise any hardware, codec, Wi-Fi or TLS stack of the real device.
 */
export class DeviceSimulator {
  readonly stats = { reconnects: 0, droppedFrames: 0, fatal: undefined as string | undefined };

  private readonly options: typeof DEFAULTS & SimulatorOptions;
  private socket?: WebSocket;
  private conversationId?: string;
  private turn?: ActiveTurn;
  private ready = false;
  private closing = false;
  private attempt = 0;
  private lastReceivedAt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private firstReady?: Deferred;

  constructor(options: SimulatorOptions) {
    this.options = { ...DEFAULTS, ...options };
    assertTransportIsSafe(options.url, this.options.allowInsecure);
  }

  /** Resolves on the first `ready`, retrying with backoff; rejects on a rejected token or after the timeout. */
  async connect(timeoutMs = 10_000): Promise<void> {
    this.firstReady = deferred();
    const timer = setTimeout(() => {
      this.firstReady?.reject(new Error("connection timeout"));
      this.close();
    }, timeoutMs);
    this.open();
    try {
      await this.firstReady.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Streams 16 kHz mono PCM as one voice turn; the handle resolves when the turn ends, is cancelled or fails. */
  speak(pcm: Uint8Array): TurnHandle {
    if (!this.ready || !this.socket) throw new Error("not connected");
    if (this.turn) throw new Error("a turn is already in progress");
    const { turn, done } = this.startTurn(randomUUID());
    void this.streamMicrophone(turn, pcm);
    return { turnId: turn.turnId, done };
  }

  private startTurn(turnId: string): { turn: ActiveTurn; done: Promise<TurnResult> } {
    let resolve!: (result: TurnResult) => void;
    const done = new Promise<TurnResult>((res) => (resolve = res));
    const turn: ActiveTurn = {
      turnId,
      transcript: "",
      assistantText: "",
      replyFormat: null,
      replyChunks: [],
      replyBytes: 0,
      replyTruncated: false,
      receivingReply: false,
      timeout: setTimeout(() => this.timeOutTurn(turnId), this.options.turnTimeoutMs),
      resolve,
    };
    this.turn = turn;
    return { turn, done };
  }

  /** Stops the active turn at once: tells the server, discards what was received and drops late frames. */
  cancel(reason: "user_stop" | "barge_in" = "user_stop"): void {
    const turn = this.turn;
    if (!turn) return;
    this.send({ type: "turn.cancel", turnId: turn.turnId, reason });
    this.finishTurn("cancelled");
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.finishTurn("disconnected");
    this.ready = false;
    this.socket?.close();
    this.socket = undefined;
  }

  private open(): void {
    const socket = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      maxPayload: 256 * 1024,
    });
    this.socket = socket;
    socket.on("open", () => this.sendHello());
    socket.on("message", (data, isBinary) => this.onData(socket, data as Buffer, isBinary));
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      this.onDrop(socket, response.statusCode === 401 ? "unauthorized" : `http ${response.statusCode}`, response.statusCode === 401);
    });
    socket.on("close", (code) => this.onDrop(socket, `close ${code}`, code === FATAL_CLOSE_CODE));
    socket.on("error", () => {});
  }

  private sendHello(): void {
    this.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      client: { kind: "simulator", version: this.options.version },
      audio: { input: [DEVICE_AUDIO_FORMAT], output: [DEVICE_AUDIO_FORMAT] },
      conversationId: this.conversationId,
    });
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onDrop(socket: WebSocket, reason: string, fatal: boolean): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.ready = false;
    this.stopHeartbeat();
    this.finishTurn("disconnected");
    this.options.log(`disconnected (${reason})`);
    if (this.closing) return;
    if (fatal) {
      this.closing = true;
      this.stats.fatal = reason;
      this.firstReady?.reject(new Error(reason));
      return;
    }
    const { minDelayMs, maxDelayMs } = this.options.reconnect;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.stats.reconnects++;
      this.open();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const { heartbeatMs } = this.options;
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > heartbeatMs * 2) {
        this.socket?.terminate();
        return;
      }
      this.send({ type: "ping", t: Date.now() });
    }, heartbeatMs);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
  }

  private onData(socket: WebSocket, data: Buffer, isBinary: boolean): void {
    if (this.socket !== socket) return;
    this.lastReceivedAt = Date.now();
    if (isBinary) {
      this.onAudioFrame(data);
      return;
    }
    try {
      const parsed = ServerMessage.safeParse(JSON.parse(data.toString("utf8")));
      if (parsed.success) this.onMessage(parsed.data);
      else this.options.log("ignored a message that does not match the protocol");
    } catch {
      this.options.log("ignored a malformed message");
    }
  }

  private onMessage(message: ServerMessage): void {
    const turn = this.turn;
    switch (message.type) {
      case "ready":
        this.conversationId = message.conversationId;
        this.ready = true;
        this.attempt = 0;
        this.lastReceivedAt = Date.now();
        this.startHeartbeat();
        this.firstReady?.resolve();
        return;
      case "transcript":
        if (turn?.turnId !== message.turnId) return;
        turn.transcript = message.text;
        if (message.final && !message.text.trim()) this.finishTurn("completed");
        return;
      case "assistant.done":
        if (turn?.turnId === message.turnId) turn.assistantText = message.text;
        return;
      case "audio.begin":
        if (turn?.turnId !== message.turnId) return;
        turn.replyFormat = message.format;
        turn.receivingReply = true;
        return;
      case "audio.end":
        if (turn?.turnId === message.turnId) turn.receivingReply = false;
        return;
      case "turn.end":
        if (turn?.turnId === message.turnId) this.finishTurn(message.status, message.errorCode);
        return;
      case "error":
        if (turn && message.turnId === turn.turnId) this.finishTurn("failed", message.code);
        else this.options.log(`server error ${message.code}`);
        return;
      default:
        return;
    }
  }

  private onAudioFrame(data: Buffer): void {
    let frame;
    try {
      frame = decodeAudioFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      return;
    }
    if (frame.kind !== BinaryFrameKind.ttsAudio) return;
    const turn = this.turn;
    if (!turn || turn.turnId !== frame.turnId || !turn.receivingReply) {
      this.stats.droppedFrames++;
      return;
    }
    if (turn.replyBytes + frame.payload.byteLength > this.options.maxReplyBytes) {
      turn.replyTruncated = true;
      return;
    }
    turn.replyChunks.push(frame.payload.slice());
    turn.replyBytes += frame.payload.byteLength;
  }

  private async streamMicrophone(turn: ActiveTurn, pcm: Uint8Array): Promise<void> {
    const { frameMs, realtime } = this.options;
    const frameBytes = ((DEVICE_AUDIO_FORMAT.sampleRate * frameMs) / 1000) * BYTES_PER_SAMPLE;
    this.send({ type: "audio.begin", conversationId: this.conversationId, turnId: turn.turnId, format: DEVICE_AUDIO_FORMAT, replyMode: "voice" });
    for (let offset = 0; offset < pcm.byteLength; offset += frameBytes) {
      await this.waitForOutboundRoom();
      if (this.turn !== turn || this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(encodeAudioFrame(BinaryFrameKind.micAudio, turn.turnId, pcm.subarray(offset, offset + frameBytes)));
      if (realtime) await sleep(frameMs);
    }
    if (this.turn === turn) this.send({ type: "audio.end", turnId: turn.turnId });
  }

  private async waitForOutboundRoom(): Promise<void> {
    await yieldToEventLoop();
    while (this.socket && this.socket.bufferedAmount > this.options.maxOutboundBufferedBytes) await sleep(5);
  }

  private timeOutTurn(turnId: string): void {
    if (this.turn?.turnId !== turnId) return;
    this.send({ type: "turn.cancel", turnId, reason: "user_stop" });
    this.finishTurn("failed", "timeout");
  }

  private finishTurn(status: TurnStatus, errorCode?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(turn.timeout);
    const discard = status === "cancelled" || status === "disconnected";
    turn.resolve({
      turnId: turn.turnId,
      status,
      errorCode,
      transcript: turn.transcript,
      assistantText: turn.assistantText,
      reply: discard ? new Uint8Array(0) : concat(turn.replyChunks, turn.replyBytes),
      replyFormat: turn.replyFormat,
      replyTruncated: turn.replyTruncated,
    });
  }
}
