import {
  BinaryFrameKind,
  PROTOCOL_VERSION,
  ServerMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  type ClientMessage,
} from "@jarvis/contracts";
import { AudioTurnGate } from "./audio-gate.js";

export interface Transport {
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export interface TransportHandlers {
  open(): void;
  close(code: number): void;
  text(data: string): void;
  binary(data: Uint8Array): void;
}

export type TransportFactory = (url: string, handlers: TransportHandlers) => Transport;

export const webSocketTransport: TransportFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => handlers.open();
  socket.onclose = (event) => handlers.close(event.code);
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") handlers.text(event.data);
    else if (event.data instanceof ArrayBuffer) handlers.binary(new Uint8Array(event.data));
  };
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
};

export function defaultSocketUrl(location: Location): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/** connecting: socket opening or waiting for `ready`. offline: down, retrying. closed: stopped. */
export type ConnectionStatus = "connecting" | "ready" | "offline" | "closed";

export interface CloseInfo {
  code: number;
  wasReady: boolean;
}

type Hello = Extract<ClientMessage, { type: "hello" }>;

export interface ReconnectPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
}

export const defaultReconnectPolicy: ReconnectPolicy = {
  initialMs: 500,
  maxMs: 15_000,
  factor: 2,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 10_000,
};

export const PING_TIMEOUT_CLOSE_CODE = 4000;

export interface ProtocolClientOptions {
  url: string;
  transport?: TransportFactory;
  client: Hello["client"];
  audio: Hello["audio"];
  conversationId?: string;
  policy?: ReconnectPolicy;
  random?: () => number;
  /** Decides whether to retry after a close; resolving false stops the client (e.g. session expired). */
  shouldReconnect?(info: CloseInfo): boolean | Promise<boolean>;
  onStatus(status: ConnectionStatus): void;
  onMessage(message: ServerMessage): void;
  onAudio(turnId: string, pcm: Uint8Array): void;
}

/**
 * Speaks the J.A.R.V.IS WebSocket protocol: hello → ready, per-connection `seq` ordering,
 * reconnection with jittered backoff that resumes the same conversation, ping liveness, and
 * speech frames filtered to the current speaking turn.
 */
export class ProtocolClient {
  readonly audioGate = new AudioTurnGate();
  private transport: Transport | null = null;
  private generation = 0;
  private status: ConnectionStatus = "closed";
  private stopped = true;
  private wasReady = false;
  private lastSeq = 0;
  private attempts = 0;
  private conversation: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly policy: ReconnectPolicy;
  private readonly createTransport: TransportFactory;

  constructor(private readonly options: ProtocolClientOptions) {
    this.policy = options.policy ?? defaultReconnectPolicy;
    this.createTransport = options.transport ?? webSocketTransport;
    this.conversation = options.conversationId;
  }

  get conversationId(): string | undefined {
    return this.conversation;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const transport = this.transport;
    this.detach();
    transport?.close(1000);
    this.setStatus("closed");
  }

  /** Reconnects immediately if the socket is down (network back, tab visible again). */
  retryNow(): void {
    if (this.stopped || this.transport) return;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.connect();
  }

  send(message: ClientMessage): boolean {
    if (this.status !== "ready" || !this.transport) return false;
    this.transport.send(JSON.stringify(message));
    return true;
  }

  sendAudio(turnId: string, pcm: Uint8Array): boolean {
    if (this.status !== "ready" || !this.transport) return false;
    this.transport.send(encodeAudioFrame(BinaryFrameKind.micAudio, turnId, pcm).slice());
    return true;
  }

  private connect(): void {
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    this.lastSeq = 0;
    this.wasReady = false;
    this.setStatus("connecting");
    this.transport = this.createTransport(this.options.url, {
      open: () => live() && this.onOpen(),
      close: (code) => live() && this.onClose(code),
      text: (data) => live() && this.onText(data),
      binary: (data) => live() && this.onBinary(data),
    });
  }

  private onOpen(): void {
    const hello: Hello = {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      client: this.options.client,
      audio: this.options.audio,
      ...(this.conversation ? { conversationId: this.conversation } : {}),
    };
    this.transport?.send(JSON.stringify(hello));
  }

  private onText(data: string): void {
    const message = parseServerMessage(data);
    if (!message || message.seq <= this.lastSeq) return;
    if (message.seq !== this.lastSeq + 1) console.warn(`protocol: seq gap ${this.lastSeq} -> ${message.seq}`);
    this.lastSeq = message.seq;

    switch (message.type) {
      case "ready":
        this.conversation = message.conversationId;
        this.attempts = 0;
        this.wasReady = true;
        this.status = "ready";
        this.startPing();
        this.options.onMessage(message);
        this.options.onStatus("ready");
        return;
      case "audio.begin":
        this.audioGate.begin(message.turnId);
        break;
      case "audio.end":
        this.audioGate.end(message.turnId);
        break;
      case "pong":
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        break;
    }
    this.options.onMessage(message);
  }

  private onBinary(data: Uint8Array): void {
    let frame;
    try {
      frame = decodeAudioFrame(data);
    } catch {
      return;
    }
    if (frame.kind !== BinaryFrameKind.ttsAudio || !this.audioGate.accepts(frame.turnId)) return;
    this.options.onAudio(frame.turnId, frame.payload);
  }

  private onClose(code: number): void {
    const wasReady = this.wasReady;
    this.detach();
    if (this.stopped) return;
    this.setStatus("offline");
    Promise.resolve()
      .then(() => this.options.shouldReconnect?.({ code, wasReady }) ?? true)
      .catch(() => true)
      .then((again) => {
        if (this.stopped || this.transport) return;
        if (again) return this.scheduleRetry();
        this.stopped = true;
        this.setStatus("closed");
      });
  }

  private detach(): void {
    this.generation++;
    this.transport = null;
    this.wasReady = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.audioGate.reset();
  }

  private onPongTimeout(): void {
    const transport = this.transport;
    this.onClose(PING_TIMEOUT_CLOSE_CODE);
    transport?.close(PING_TIMEOUT_CLOSE_CODE, "ping timeout");
  }

  private scheduleRetry(): void {
    const { initialMs, maxMs, factor } = this.policy;
    const base = Math.min(maxMs, initialMs * factor ** this.attempts);
    const delay = base * (0.5 + (this.options.random ?? Math.random)() * 0.5);
    this.attempts++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.transport) return;
      this.transport.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMessage));
      this.pongTimer ??= setTimeout(() => this.onPongTimeout(), this.policy.pongTimeoutMs);
    }, this.policy.pingIntervalMs);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}

function parseServerMessage(data: string): ServerMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    console.warn("protocol: non-JSON server message");
    return null;
  }
  const parsed = ServerMessage.safeParse(json);
  if (parsed.success) return parsed.data;
  const type = typeof json === "object" && json !== null && "type" in json ? String(json.type) : "unknown";
  console.warn(`protocol: invalid server message of type ${type}`);
  return null;
}
