import type { SpeakerCheck, SpeakerVerdict } from "../voice/speaker-check.js";
import { randomUUID } from "node:crypto";
import {
  BinaryFrameKind,
  ClientMessage,
  PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
  finalActivityPhases,
  type AudioFormat,
  type BuildChatMessage,
  type BuildChatState,
  type Card,
  type ClientKind,
  type HistoryItem,
  type OutgoingServerMessage,
  type ReplyMode,
} from "@jarvis/contracts";
import type { WebSocket } from "ws";
import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ConversationHub, Subscriber } from "../conversation/hub.js";
import type { ConversationOrchestrator, Logger } from "../conversation/orchestrator.js";
import { turnLooksComplete } from "../voice/end-of-turn.js";
import { isBackchannel, isFillerTranscript, isStockPhrase } from "../voice/filler.js";
import type { AudioSink, SpeechCapture, SpeechToTextService, TextToSpeechService, TranscriptResult } from "../voice/types.js";
import type { z } from "zod";

const HELLO_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const AUDIO_HIGH_WATER_BYTES = 256 * 1024;
/** Above this backlog, intermediate activity updates are dropped; the final ones always go out. */
const ACTIVITY_HIGH_WATER_BYTES = 64 * 1024;
const MAX_CAPTURE_SECONDS = 120;
/** Speech over the reply longer than this is a real interruption, so its pauses get the normal end-of-turn wait. */
const PROVISIONAL_MAX_SECONDS = 1.5;
/** After a pause whose words sound unfinished, how long the server waits for the owner to go on. */
const END_OF_TURN_WAIT_MS = 1800;
const MAX_MESSAGES_PER_SECOND = 40;
const REAUTH_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_PAGE = 40;

export type PushSubscription = Extract<ClientMessage, { type: "push.subscribe" }>["subscription"];
export type PlayerState = Extract<ClientMessage, { type: "player.state" }>;
export type TaskAction = Extract<ClientMessage, { type: "task.action" }>;

/** What a task card tap produced: the refreshed card, or why nothing changed. */
export type TaskActionOutcome = { ok: true; card: Card; message: string } | { ok: false; message: string };

/** Build mode: requests and answers become tasks on the jarvis project without going through the model. */
/** Construir, as a conversation with the agent that changes JARVIS. */
export interface BuildHandlers {
  view(): { messages: BuildChatMessage[]; state: BuildChatState };
  request(text: string): void;
  stop(): void;
}

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
  onTaskAction?(action: TaskAction): TaskActionOutcome;
  /** The current state of a card stored in history (a task that moved on, a confirmation already decided). */
  refreshCard?(card: Card): Card;
  build?: BuildHandlers;
  /** The owner's voiceprint: in a call, speech from anyone else is dropped like noise. */
  speaker?: Pick<SpeakerCheck, "matches" | "enrolled">;
}

interface Capture {
  capture: SpeechCapture;
  controller: AbortController;
  bytes: number;
  maxBytes: number;
  replyMode: ReplyMode;
  dictation: boolean;
  /** Heard while the reply was playing: dropped if it turns out to be a backchannel. */
  provisional: boolean;
  paused: boolean;
  /** Bumped by every pause and resume, so a late decision about an older pause is ignored. */
  generation: number;
  pausedAt?: number;
  checkpoint?: { generation: number; result: Promise<TranscriptResult | undefined> };
  /** The pause reused a transcription started at the earlier tentative pause. */
  earlyCheckpoint?: boolean;
  timer?: NodeJS.Timeout;
  sampleRate: number;
  /** The first seconds of a call utterance, kept to check whose voice it is. */
  voice: Buffer[];
  voiceBytes: number;
}

/** Seconds of each call utterance used to recognize the speaker. */
const SPEAKER_WINDOW_SECONDS = 3;

/** One authenticated WebSocket client (browser or device) speaking the J.A.R.V.IS protocol. */
export class ClientConnection implements Subscriber {
  private seq = 0;
  private conversationId?: string;
  private unsubscribe?: () => void;
  private outputFormat: AudioFormat | null = null;
  private sendHistory = true;
  private inCall = false;
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
    if (message.type === "activity" && !finalActivityPhases.has(message.phase) && this.socket.bufferedAmount > ACTIVITY_HIGH_WATER_BYTES) return;
    this.socket.send(JSON.stringify({ ...message, seq: ++this.seq }));
  }

  private dispose(): void {
    clearTimeout(this.helloTimer);
    clearInterval(this.reauthTimer);
    this.unsubscribe?.();
    for (const capture of this.captures.values()) {
      clearTimeout(capture.timer);
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
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          createSpeaker: this.speakerFactory(message.turnId, message.replyMode),
        });
        return;
      case "audio.begin":
        return this.onAudioBegin(message);
      case "audio.end":
        return this.onAudioEnd(message.turnId);
      case "audio.pause":
        return message.tentative ? this.onTentativePause(message.turnId) : this.onAudioPause(message.turnId);
      case "audio.resume":
        return this.onAudioResume(message.turnId);
      case "turn.cancel": {
        const capture = this.captures.get(message.turnId);
        if (capture) {
          this.captures.delete(message.turnId);
          clearTimeout(capture.timer);
          capture.controller.abort();
          capture.capture.cancel();
          this.deps.orchestrator.discardPrepared(message.turnId);
          if (!capture.dictation) this.send({ type: "state", state: "idle" });
          return;
        }
        this.deps.orchestrator.cancel(message.turnId, message.reason);
        return;
      }
      case "action.decide":
        await this.deps.orchestrator.decideAction(message.actionId, message.decision);
        return;
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
        this.send({ type: "history", conversationId: message.conversationId, ...page, items: this.refreshed(page.items) });
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
      case "task.action":
        return this.onTaskAction(message);
      case "call.state":
        this.inCall = message.active;
        return;
      case "warm":
        if (this.conversationId) this.deps.orchestrator.warm(this.conversationId);
        return;
      case "client.audio": {
        const { type: _type, ...audio } = message;
        this.deps.log.info({ audio }, "client audio");
        return;
      }
      case "client.viewport": {
        const { type: _type, ...viewport } = message;
        this.deps.log.info({ viewport }, "client viewport");
        return;
      }
      case "build.list":
        return this.sendBuildChat();
      case "build.request":
        this.deps.build?.request(message.text);
        return this.sendBuildChat();
      case "build.stop":
        this.deps.build?.stop();
        return this.sendBuildChat();
      case "ping":
        this.send({ type: "pong", t: message.t });
        return;
    }
  }

  private onTaskAction(message: TaskAction): void {
    const outcome = this.deps.onTaskAction?.(message);
    if (!outcome) {
      this.send({ type: "notice", level: "warning", code: "tasks_unavailable", message: "Las tareas delegadas no están configuradas." });
      return;
    }
    if (outcome.ok && this.conversationId) {
      const card = outcome.card;
      const task = card.kind === "task" ? ` en la tarea #${card.ref} «${card.title}»` : "";
      this.deps.hub.emit(this.conversationId, { type: "card", card });
      this.deps.orchestrator.addNote(this.conversationId, `[nota del sistema: el dueño tocó «${message.action}»${task}: ${outcome.message} La tarjeta ya muestra el estado nuevo.]`);
    }
    this.send({ type: "notice", level: outcome.ok ? "info" : "warning", code: outcome.ok ? "task_updated" : "task_action_rejected", message: outcome.message });
  }

  private refreshed(items: HistoryItem[]): HistoryItem[] {
    const refresh = this.deps.refreshCard;
    if (!refresh) return items;
    return items.map((item) => (item.cards.length ? { ...item, cards: item.cards.map((card) => refresh(card)) } : item));
  }

  /**
   * Says background news aloud while the owner is in a call and nothing else is talking or
   * listening; otherwise the chat message and the push are enough.
   */
  announce(text: string): void {
    const conversationId = this.conversationId;
    if (!this.inCall || !conversationId || this.captures.size > 0 || this.deps.orchestrator.runningTurn(conversationId)) return;
    const spoken = text.replace(/https?:\/\/\S+/g, "te dejé el link en el chat").trim();
    const speaker = spoken ? this.speakerFactory(randomUUID(), "voice")?.(new AbortController().signal) : undefined;
    if (!speaker) return;
    speaker.textDelta(spoken);
    speaker.finish().catch((error: unknown) => this.deps.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "announcement failed"));
  }

  private sendBuildChat(): void {
    if (!this.deps.build) {
      this.send({ type: "notice", level: "warning", code: "build_unavailable", message: "El modo construir no está configurado." });
      return;
    }
    this.send({ type: "build.chat", ...this.deps.build.view() });
  }

  private onHello(message: Extract<ClientMessage, { type: "hello" }>): void {
    if (this.conversationId) return;
    clearTimeout(this.helloTimer);
    this.outputFormat = this.deps.tts.available() ? this.deps.tts.chooseOutputFormat(message.audio.output) : null;
    this.sendHistory = message.history !== false;
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
        speakerCheck: this.deps.speaker?.enrolled() === true,
      },
    });
    if (this.sendHistory) {
      const page = this.deps.store.history(conversationId, HISTORY_PAGE);
      this.send({ type: "history", conversationId, ...page, items: this.refreshed(page.items) });
    }
    const activeTurn = this.deps.orchestrator.activeTurn(conversationId);
    this.send(activeTurn ? { type: "state", state: "thinking", turnId: activeTurn } : { type: "state", state: "idle" });
    for (const event of this.deps.orchestrator.openActivity(conversationId)) this.send({ type: "activity", ...event });
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
      dictation: message.purpose === "dictation",
      provisional: message.duringPlayback === true,
      paused: false,
      generation: 0,
      sampleRate: message.format.sampleRate,
      voice: [],
      voiceBytes: 0,
    });
    if (message.purpose !== "dictation") this.deps.orchestrator.prepareTurn(message.conversationId, message.turnId);
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
    if (this.inCall && this.deps.speaker && !capture.dictation && capture.voiceBytes < capture.sampleRate * 2 * SPEAKER_WINDOW_SECONDS) {
      capture.voice.push(Buffer.from(frame.payload));
      capture.voiceBytes += frame.payload.byteLength;
    }
  }

  /**
   * A pause inside an utterance: transcribes what was said and closes the turn right away when it
   * sounds finished; otherwise waits a little for the owner to go on. The server is the only one
   * that confirms the end of a turn.
   */
  /** A short silence: transcribes in advance so a real pause can be decided without waiting for Whisper. */
  private onTentativePause(turnId: string): void {
    const capture = this.captures.get(turnId);
    if (!capture || capture.dictation || capture.provisional || !capture.capture.peek) return;
    const generation = ++capture.generation;
    capture.checkpoint = { generation, result: capture.capture.peek().catch(() => undefined) };
  }

  private onAudioPause(turnId: string): void {
    const capture = this.captures.get(turnId);
    if (!capture || capture.dictation) return;
    if (capture.provisional && capture.bytes < capture.maxBytes * (PROVISIONAL_MAX_SECONDS / MAX_CAPTURE_SECONDS)) {
      this.deps.log.info({ turnId, reason: "candidate" }, "turn endpoint");
      return void this.onAudioEnd(turnId);
    }
    clearTimeout(capture.timer);
    const early = capture.checkpoint?.generation === capture.generation ? capture.checkpoint : undefined;
    const generation = early ? capture.generation : ++capture.generation;
    capture.paused = true;
    capture.pausedAt = performance.now();
    const result = early?.result ?? (capture.capture.peek ? capture.capture.peek().catch(() => undefined) : Promise.resolve(undefined));
    capture.checkpoint = { generation, result };
    capture.earlyCheckpoint = early !== undefined;
    capture.timer = setTimeout(() => this.closeTurn(turnId, generation, "silence"), END_OF_TURN_WAIT_MS);
    void result.then((transcript) => {
      if (transcript && turnLooksComplete(transcript.text)) this.closeTurn(turnId, generation, "complete");
    });
  }

  private onAudioResume(turnId: string): void {
    const capture = this.captures.get(turnId);
    if (!capture) return;
    clearTimeout(capture.timer);
    capture.paused = false;
    capture.generation += 1;
  }

  private closeTurn(turnId: string, generation: number, reason: "complete" | "silence"): void {
    const capture = this.captures.get(turnId);
    if (!capture || !capture.paused || capture.generation !== generation) return;
    const checkpoint = capture.checkpoint?.generation === generation ? capture.checkpoint.result : undefined;
    this.deps.log.info({ turnId, reason, early: capture.earlyCheckpoint === true, pauseMs: Math.round(performance.now() - (capture.pausedAt ?? 0)) }, "turn endpoint");
    void this.onAudioEnd(turnId, checkpoint);
  }

  /** Ends a capture: transcribes it (or reuses the transcript taken at the pause) and starts the turn. */
  private async onAudioEnd(turnId: string, ready?: Promise<TranscriptResult | undefined>): Promise<void> {
    const capture = this.captures.get(turnId);
    if (!capture || !this.conversationId) return;
    this.captures.delete(turnId);
    clearTimeout(capture.timer);
    if (capture.dictation) return this.finishDictation(turnId, capture);
    const inputEndedAt = performance.now();
    const voiceCheck = this.checkSpeaker(turnId, capture);
    if (!capture.provisional) this.send({ type: "state", state: "transcribing", turnId });
    let transcript;
    try {
      transcript = (await ready) ?? (await capture.capture.finish());
    } catch (error) {
      if (capture.controller.signal.aborted) return;
      this.deps.orchestrator.discardPrepared(turnId);
      this.deps.log.warn({ turnId, err: error instanceof Error ? error.message : "unknown" }, "transcription failed");
      this.send({ type: "error", code: "stt_failed", message: "No pude transcribir el audio. Probá de nuevo o escribime.", turnId, retryable: true });
      this.send({ type: "state", state: "idle" });
      return;
    }
    if (capture.controller.signal.aborted) return;
    const text = isStockPhrase(transcript.text) ? "" : transcript.text.trim();
    const running = this.deps.orchestrator.runningTurn(this.conversationId);
    const noise = running !== undefined && running.turnId !== turnId && isFillerTranscript(text);
    const backchannel = capture.provisional && (isFillerTranscript(text) || isBackchannel(text));
    const stranger = (await voiceCheck)?.owner === false;
    if (noise || backchannel || stranger) {
      this.deps.orchestrator.discardPrepared(turnId);
      if (backchannel) this.deps.log.info({ turnId, words: text.split(/\s+/).filter(Boolean).length }, "backchannel kept the reply playing");
      this.send({ type: "turn.end", turnId, status: "cancelled" });
      this.send(running ? { type: "state", state: running.replying ? "speaking" : "thinking", turnId: running.turnId } : { type: "state", state: "idle" });
      return;
    }
    this.send({ type: "transcript", turnId, text, final: true });
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

  /** Whose voice a call utterance is; logs the score so the threshold can be tuned with real calls. */
  private async checkSpeaker(turnId: string, capture: Capture): Promise<SpeakerVerdict | undefined> {
    if (!this.deps.speaker || capture.voice.length === 0) return undefined;
    try {
      const verdict = await this.deps.speaker.matches(Buffer.concat(capture.voice), capture.sampleRate);
      if (verdict) this.deps.log.info({ turnId, score: verdict.score, owner: verdict.owner, provisional: capture.provisional }, "speaker score");
      return verdict;
    } catch (error) {
      this.deps.log.warn({ turnId, err: error instanceof Error ? error.message : "unknown" }, "speaker check failed");
      return undefined;
    }
  }

  private async finishDictation(turnId: string, capture: Capture): Promise<void> {
    try {
      const transcript = await capture.capture.finish();
      if (capture.controller.signal.aborted) return;
      this.send({ type: "transcript", turnId, text: isStockPhrase(transcript.text) ? "" : transcript.text.trim(), final: true });
    } catch (error) {
      if (capture.controller.signal.aborted) return;
      this.deps.log.warn({ turnId, err: error instanceof Error ? error.message : "unknown" }, "dictation failed");
      this.send({ type: "error", code: "stt_failed", message: "No pude transcribir el audio. Probá de nuevo o escribime.", turnId, retryable: true });
    }
  }
}
