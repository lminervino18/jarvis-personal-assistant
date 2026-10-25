import type { Socket } from "node:net";
import {
  BinaryFrameKind,
  ServerMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioFormat,
  type ClientMessage,
} from "@jarvis/contracts";
import { WebSocket } from "ws";

export interface AudioFrameEvent {
  type: "frame";
  turnId: string;
  kind: number;
  payload: Uint8Array;
}

export type TimelineEvent = ServerMessage | AudioFrameEvent;
type Of<T extends TimelineEvent["type"]> = Extract<TimelineEvent, { type: T }>;

export const MIC_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };
const MIC_FRAME_BYTES = 640;

export interface ConnectOptions {
  origin: string;
  cookie?: string;
}

export interface UpgradeOptions extends Partial<ConnectOptions> {
  authorization?: string;
}

/** Refused WebSocket upgrades surface as the HTTP status the server answered with. */
export async function upgradeStatus(url: string, options: UpgradeOptions): Promise<number> {
  const headers: Record<string, string> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.authorization) headers.authorization = options.authorization;
  return new Promise((resolveStatus, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      socket.terminate();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.terminate();
      resolveStatus(101);
    });
    socket.once("error", reject);
  });
}

/** Records everything the server sends, in arrival order, validating each JSON message against the shared contract. */
export class E2eClient {
  readonly timeline: TimelineEvent[] = [];
  private waiters: Array<() => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = "nodebuffer";
    socket.on("message", (data, isBinary) => {
      this.timeline.push(isBinary ? this.frame(data as Buffer) : ServerMessage.parse(JSON.parse((data as Buffer).toString("utf8"))));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async connect(url: string, options: ConnectOptions): Promise<E2eClient> {
    const headers: Record<string, string> = { origin: options.origin };
    if (options.cookie) headers.cookie = options.cookie;
    const socket = new WebSocket(url, { headers });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", () => resolveOpen());
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade refused with ${response.statusCode}`)));
    });
    return new E2eClient(socket);
  }

  private frame(data: Buffer): AudioFrameEvent {
    const { kind, turnId, payload } = decodeAudioFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return { type: "frame", kind, turnId, payload };
  }

  of<T extends TimelineEvent["type"]>(type: T): Of<T>[] {
    return this.timeline.filter((event): event is Of<T> => event.type === type);
  }

  frames(turnId: string): AudioFrameEvent[] {
    return this.of("frame").filter((event) => event.turnId === turnId);
  }

  audioBytes(turnId: string): number {
    return this.frames(turnId).reduce((total, event) => total + event.payload.byteLength, 0);
  }

  indexOf(predicate: (event: TimelineEvent) => boolean): number {
    return this.timeline.findIndex(predicate);
  }

  async waitFor<T extends TimelineEvent["type"]>(type: T, predicate: (event: Of<T>) => boolean = () => true, timeoutMs = 15_000): Promise<Of<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.of(type).find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}; saw ${this.timeline.map((event) => event.type).join(",")}`);
      await new Promise<void>((wake) => {
        const timer = setTimeout(wake, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          wake();
        });
      });
    }
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async hello(output: AudioFormat[], conversationId?: string): Promise<Of<"ready">> {
    const already = this.of("ready").length;
    this.send({
      type: "hello",
      protocol: 1,
      client: { kind: "simulator", version: "e2e" },
      audio: { input: [MIC_FORMAT], output },
      ...(conversationId ? { conversationId } : {}),
    });
    return this.waitFor("ready", () => this.of("ready").length > already);
  }

  sendText(conversationId: string, turnId: string, text: string, replyMode: "text" | "voice" = "text"): void {
    this.send({ type: "user.text", conversationId, turnId, text, replyMode });
  }

  speak(conversationId: string, turnId: string, replyMode: "text" | "voice" = "voice", seconds = 1): void {
    this.send({ type: "audio.begin", conversationId, turnId, format: MIC_FORMAT, replyMode });
    const frames = Math.round((seconds * 1000) / 20);
    for (let i = 0; i < frames; i++) this.socket.send(encodeAudioFrame(BinaryFrameKind.micAudio, turnId, new Uint8Array(MIC_FRAME_BYTES)));
    this.send({ type: "audio.end", turnId });
  }

  pauseReading(): void {
    this.rawSocket().pause();
  }

  resumeReading(): void {
    this.rawSocket().resume();
  }

  private rawSocket(): Socket {
    return (this.socket as unknown as { _socket: Socket })._socket;
  }

  close(): void {
    this.socket.terminate();
  }
}
