import {
  BinaryFrameKind,
  ClientMessage,
  PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioFormat,
  type ClientKind,
  type OutgoingServerMessage,
  type ReplyMode,
} from "@jarvis/contracts";
import type { WebSocket } from "ws";
import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ConversationHub, Subscriber } from "../conversation/hub.js";
import type { ConversationOrchestrator, Logger } from "../conversation/orchestrator.js";
import type { AudioSink, SpeechCapture, SpeechToTextService, TextToSpeechService } from "../voice/types.js";
import type { z } from "zod";

const HELLO_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const AUDIO_HIGH_WATER_BYTES = 256 * 1024;
const MAX_CAPTURE_SECONDS = 120;
const MAX_MESSAGES_PER_SECOND = 40;
const REAUTH_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_PAGE = 40;

export type PushSubscription = Extract<ClientMessage, { type: "push.subscribe" }>["subscription"];
export type PlayerState = Extract<ClientMessage, { type: "player.state" }>;

export interface ConnectionDeps {
  kind: ClientKind;
  store: ConversationStore;
  hub: ConversationHub;
  orchestrator: ConversationOrchestrator;
  stt: SpeechToTextService;
  tts: TextToSpeechService;
  ownerName: string;
  followUpWindowMs: number;
  pushPublicKey: string | null;
  log: Logger;
  isStillAuthorized(): boolean;
  onPushSubscribe?(subscription: PushSubscription): Promise<void>;
  onPlayerState?(state: PlayerState): void;
}

interface Capture {
  capture: SpeechCapture;
  controller: AbortController;
  bytes: number;
  maxBytes: number;
  replyMode: ReplyMode;
}

/** One authenticated WebSocket client (browser or device) speaking the J.A.R.V.IS protocol. */
export class ClientConnection implements Subscriber {
  private seq = 0;
  private conversationId?: string;
  private unsubscribe?: () => void;
  private outputFormat: AudioFormat | null = null;
  private readonly captures = new Map<string, Capture>();
  private readonly helloTimer: NodeJS.Timeout;
  private readonly reauthTimer: NodeJS.Timeout;
  private windowStart = Date.now();
  private windowCount = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    socket.binaryType = "nodebuffer";
    socket.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
    this.helloTimer = setTimeout(() => !this.conversationId && socket.close(4000, "hello timeout"), HELLO_TIMEOUT_MS);
    this.reauthTimer = setInterval(() => !deps.isStillAuthorized() && socket.close(4001, "session expired"), REAUTH_INTERVAL_MS);
  }

  send(message: OutgoingServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.socket.close(1013, "client too slow");
      return;
    }
    this.socket.send(JSON.stringify({ ...message, seq: ++this.seq }));
  }

  private dispose(): void {
    clearTimeout(this.helloTimer);
    clearInterval(this.reauthTimer);
    this.unsubscribe?.();
    for (const capture of this.captures.values()) {
      capture.controller.abort();
      capture.capture.cancel();
    }
    this.captures.clear();
  }

  private overRateLimit(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    return ++this.windowCount > MAX_MESSAGES_PER_SECOND;
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.onAudioFrame(data);
      return;
    }
    if (this.overRateLimit()) {
      this.send({ type: "error", code: "rate_limited", message: "Demasiados mensajes.", retryable: true });
      return;
    }
    let parsed: z.ZodSafeParseResult<ClientMessage>;
    try {
      parsed = ClientMessage.safeParse(JSON.parse(data.toString("utf8")));
    } catch {
      this.send({ type: "error", code: "bad_request", message: "Mensaje inválido.", retryable: false });
      return;
    }
    if (!parsed.success) {
      this.send({ type: "error", code: "bad_request", message: "Mensaje inválido.", retryable: false });
      return;
    }
    const message = parsed.data;
    if (message.type !== "hello" && !this.conversationId) {
      this.send({ type: "error", code: "bad_request", message: "Falta el saludo inicial.", retryable: false });
      return;
    }
    void this.handle(message).catch((error: unknown) => {
      this.deps.log.error({ type: message.type, err: error instanceof Error ? error.message : "unknown" }, "ws handler failed");
      this.send({ type: "error", code: "internal", message: "Error interno.", retryable: true });
    });
  }

  private async handle(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        return this.onHello(message);
      case "user.text":
        if (!this.ownsConversation(message.conversationId)) return;
        void this.deps.orchestrator.startTurn({
          conversationId: message.conversationId,
          turnId: message.turnId,
          text: message.text,
          inputMode: "text",
          replyMode: message.replyMode,
          inputEndedAt: performance.now(),
          createSpeaker: this.speakerFactory(message.turnId, message.replyMode),
        });
        return;
      case "audio.begin":
        return this.onAudioBegin(message);
      case "audio.end":
        return this.onAudioEnd(message.turnId);
      case "turn.cancel": {
        const capture = this.captures.get(message.turnId);
        if (capture) {
          this.captures.delete(message.turnId);
          capture.controller.abort();
          capture.capture.cancel();
          this.send({ type: "state", state: "idle" });
          return;
        }
        this.deps.orchestrator.cancel(message.turnId, message.reason);
        return;
      }
      case "action.decide":
        return this.deps.orchestrator.decideAction(message.actionId, message.decision);
      case "player.state":
        this.deps.onPlayerState?.(message);
        return;
      case "client.metrics":
        this.deps.store.recordClientMetrics(message.turnId, message.firstAudioMs, message.firstTextMs);
        return;
      case "conversation.new":
        this.attach(this.deps.store.create().id);
        return;
      case "history.fetch": {
        if (!this.ownsConversation(message.conversationId)) return;
        const page = this.deps.store.history(message.conversationId, message.limit, message.beforeMessageId);
        this.send({ type: "history", conversationId: message.conversationId, ...page });
        return;
      }
      case "push.subscribe":
        if (!this.deps.onPushSubscribe) {
          this.send({ type: "notice", level: "warning", code: "push_unavailable", message: "Las notificaciones no están configuradas." });
          return;
        }
        try {
          await this.deps.onPushSubscribe(message.subscription);
        } catch (error) {
          this.deps.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "push subscription rejected");
          this.send({ type: "error", code: "bad_request", message: "Ese dispositivo no puede recibir notificaciones.", retryable: false });
          return;
        }
        this.send({ type: "notice", level: "info", code: "push_subscribed", message: "Notificaciones activadas en este dispositivo." });
        return;
      case "ping":
        this.send({ type: "pong", t: message.t });
        return;
    }
  }

  private onHello(message: Extract<ClientMessage, { type: "hello" }>): void {
    if (this.conversationId) return;
    clearTimeout(this.helloTimer);
    this.outputFormat = this.deps.tts.available() ? this.deps.tts.chooseOutputFormat(message.audio.output) : null;
    this.attach(this.deps.store.resolveOrCreate(message.conversationId).id);
  }

  private attach(conversationId: string): void {
    this.unsubscribe?.();
    this.conversationId = conversationId;
    this.unsubscribe = this.deps.hub.subscribe(conversationId, this);
    this.send({
      type: "ready",
      protocol: PROTOCOL_VERSION,
      conversationId,
      owner: { displayName: this.deps.ownerName },
      capabilities: {
        stt: this.deps.stt.available(),
        tts: this.outputFormat !== null,
        ttsProvider: this.outputFormat ? this.deps.tts.provider : null,
        outputFormat: this.outputFormat,
        followUpWindowMs: this.deps.followUpWindowMs,
        pushPublicKey: this.deps.pushPublicKey,
      },
    });
    const page = this.deps.store.history(conversationId, HISTORY_PAGE);
    this.send({ type: "history", conversationId, ...page });
    const activeTurn = this.deps.orchestrator.activeTurn(conversationId);
    this.send(activeTurn ? { type: "state", state: "thinking", turnId: activeTurn } : { type: "state", state: "idle" });
  }

  private ownsConversation(conversationId: string): boolean {
    if (conversationId === this.conversationId) return true;
    this.send({ type: "error", code: "bad_request", message: "Conversación desconocida para esta conexión.", retryable: false });
    return false;
  }

  private speakerFactory(turnId: string, replyMode: ReplyMode) {
    if (replyMode !== "voice") return undefined;
    const output = this.outputFormat;
    if (!output) {
      this.send({ type: "notice", level: "warning", code: "tts_unavailable", message: "La voz no está disponible; respondo por texto." });
      return undefined;
    }
    return (signal: AbortSignal) => this.deps.tts.createSpeaker({ turnId, output, sink: this.audioSink(turnId), signal });
  }

  private audioSink(turnId: string): AudioSink {
    return {
      begin: (format, processed) => {
        this.send({ type: "audio.begin", turnId, format, processed });
        this.send({ type: "state", state: "speaking", turnId });
      },
      write: (pcm) => {
        if (this.socket.readyState !== this.socket.OPEN) return false;
        this.socket.send(encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, pcm));
        return this.socket.bufferedAmount < AUDIO_HIGH_WATER_BYTES;
      },
      waitForDrain: async () => {
        while (this.socket.readyState === this.socket.OPEN && this.socket.bufferedAmount >= AUDIO_HIGH_WATER_BYTES / 2) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      end: (reason) => this.send({ type: "audio.end", turnId, reason }),
    };
  }

  private onAudioBegin(message: Extract<ClientMessage, { type: "audio.begin" }>): void {
    if (!this.ownsConversation(message.conversationId)) return;
    if (!this.deps.stt.available()) {
      this.send({ type: "error", code: "stt_failed", message: "La transcripción no está configurada; escribime.", turnId: message.turnId, retryable: false });
      return;
    }
    if (this.captures.size > 0) {
      this.send({ type: "error", code: "busy", message: "Ya hay una captura de audio en curso.", turnId: message.turnId, retryable: true });
      return;
    }
    const controller = new AbortController();
    const capture = this.deps.stt.startCapture({
      turnId: message.turnId,
      format: message.format,
      signal: controller.signal,
      onPartial: (text) => this.send({ type: "transcript", turnId: message.turnId, text, final: false }),
    });
    this.captures.set(message.turnId, {
      capture,
      controller,
      bytes: 0,
      maxBytes: message.format.sampleRate * 2 * MAX_CAPTURE_SECONDS,
      replyMode: message.replyMode,
    });
  }

  private onAudioFrame(data: Buffer): void {
    let frame;
    try {
      frame = decodeAudioFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      return;
    }
    if (frame.kind !== BinaryFrameKind.micAudio) return;
    const capture = this.captures.get(frame.turnId);
    if (!capture) return;
    capture.bytes += frame.payload.byteLength;
    if (capture.bytes > capture.maxBytes) {
      void this.onAudioEnd(frame.turnId);
      return;
    }
    capture.capture.push(frame.payload);
  }

  private async onAudioEnd(turnId: string): Promise<void> {
    const capture = this.captures.get(turnId);
    if (!capture || !this.conversationId) return;
    this.captures.delete(turnId);
    const inputEndedAt = performance.now();
    this.send({ type: "state", state: "transcribing", turnId });
    let transcript;
    try {
      transcript = await capture.capture.finish();
    } catch (error) {
      if (capture.controller.signal.aborted) return;
      this.deps.log.warn({ turnId, err: error instanceof Error ? error.message : "unknown" }, "transcription failed");
      this.send({ type: "error", code: "stt_failed", message: "No pude transcribir el audio. Probá de nuevo o escribime.", turnId, retryable: true });
      this.send({ type: "state", state: "idle" });
      return;
    }
    if (capture.controller.signal.aborted) return;
    const text = transcript.text.trim();
    this.send({ type: "transcript", turnId, text, final: true });
    if (!text) {
      this.send({ type: "state", state: "idle" });
      return;
    }
    void this.deps.orchestrator.startTurn({
      conversationId: this.conversationId,
      turnId,
      text,
      inputMode: "voice",
      replyMode: capture.replyMode,
      inputEndedAt,
      sttMs: Math.round(transcript.latencyMs),
      createSpeaker: this.speakerFactory(turnId, capture.replyMode),
    });
  }
}
