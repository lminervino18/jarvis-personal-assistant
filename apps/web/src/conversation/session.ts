import {
  STT_INPUT_FORMAT,
  type AssistantState,
  type AudioFormat,
  type Card,
  type ClientMessage,
  type ServerAssistantState,
  type ServerMessage,
} from "@jarvis/contracts";
import { MicError, type AudioEngine } from "../audio/engine.js";
import { pcm16ToBytes } from "../audio/pcm.js";
import type { PcmPlayerOptions } from "../audio/playback.js";
import { VoiceLoop } from "../audio/voice-loop.js";
import { ProtocolClient, defaultSocketUrl, type CloseInfo, type ConnectionStatus, type TransportFactory } from "../protocol/client.js";
import { deriveState, isBusy } from "./assistant-state.js";
import { integrationResultCard, type IntegrationResult } from "./integration-result.js";
import { emptyThread, reduceThread, type ThreadEvent, type ThreadState } from "./thread.js";

export type Capabilities = Extract<ServerMessage, { type: "ready" }>["capabilities"];
export type PlayerReport = Extract<ClientMessage, { type: "player.state" }>["state"];
type PlayerCommand = Extract<ServerMessage, { type: "player.command" }>;

export interface Notice {
  id: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface SessionSnapshot {
  connection: ConnectionStatus;
  state: AssistantState;
  busy: boolean;
  thread: ThreadState;
  capabilities: Capabilities | null;
  ownerName: string | null;
  micOpen: boolean;
  audioBlocked: boolean;
  notice: Notice | null;
  needsLogin: boolean;
}

export interface Levels {
  input: number;
  output: number;
}

export interface PlayerHandle {
  play(): void;
  pause(): void;
}

export type PushResult = { ok: true } | { ok: false; message: string };

export interface SessionDeps {
  url?: string;
  transport?: TransportFactory;
  createEngine(options: PcmPlayerOptions): AudioEngine;
  isSessionValid?(): Promise<boolean>;
  subscribePush?(publicKey: string): Promise<PushResult & { subscription?: Extract<ClientMessage, { type: "push.subscribe" }>["subscription"] }>;
  newId?(): string;
  now?(): number;
}

interface TurnTiming {
  inputEndedAt: number;
  voice: boolean;
  firstTextMs?: number;
  firstAudioMs?: number;
  ended: boolean;
}

const INITIAL_LISTEN_MS = 12_000;
const PLAYBACK_LEAD_SECONDS = 0.12;
const HISTORY_PAGE = 40;
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const OUTPUT_FORMATS: AudioFormat[] = [24000, 16000, 22050, 48000].map((sampleRate) => ({
  encoding: "pcm_s16le",
  sampleRate: sampleRate as AudioFormat["sampleRate"],
  channels: 1,
}));

const threadEventTypes = new Set<ServerMessage["type"]>(["history", "assistant.delta", "assistant.done", "card", "transcript", "error", "turn.end"]);

/** Owns one conversation with the server: protocol, thread, microphone, playback and the derived UI state. */
export class Session {
  private readonly client: ProtocolClient;
  private readonly voice: VoiceLoop;
  private readonly listeners = new Set<() => void>();
  private readonly timings = new Map<string, TurnTiming>();
  private readonly players = new Map<string, PlayerHandle>();
  private readonly pendingCommands = new Map<string, PlayerCommand>();
  private readonly pendingCards: Card[] = [];
  private engine: AudioEngine | null = null;
  private thread: ThreadState = emptyThread();
  private capabilities: Capabilities | null = null;
  private ownerName: string | null = null;
  private serverState: ServerAssistantState = "idle";
  private activeTurn: string | null = null;
  private captureTurn: string | null = null;
  private micOpen = false;
  private micStarting = false;
  private audioWanted = false;
  private needsLogin = false;
  private notice: Notice | null = null;
  private noticeCount = 0;
  private inputLevel = 0;
  private readonly levels: Levels = { input: 0, output: 0 };
  private status: ConnectionStatus = "closed";
  private snapshot: SessionSnapshot;

  constructor(private readonly deps: SessionDeps) {
    this.client = new ProtocolClient({
      url: deps.url ?? defaultSocketUrl(location),
      transport: deps.transport,
      client: { kind: "web", version: "0.1.0" },
      audio: { input: [STT_INPUT_FORMAT], output: OUTPUT_FORMATS.slice(0, 4) },
      shouldReconnect: (info) => this.shouldReconnect(info),
      onStatus: (status) => this.onStatus(status),
      onMessage: (message) => this.onMessage(message),
      onAudio: (turnId, pcm) => this.engine?.player.enqueue(turnId, pcm),
    });
    this.voice = new VoiceLoop({
      onStart: () => this.beginUtterance(),
      onFrame: (pcm) => this.sendFrame(pcm),
      onEnd: () => this.endUtterance(),
      onLevel: (level) => void (this.inputLevel = level),
      onTimeout: () => this.closeMicrophone(),
    });
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  getLevels = (): Levels => {
    this.levels.input = this.micOpen ? this.inputLevel : 0;
    this.levels.output = this.engine?.outputLevel() ?? 0;
    return this.levels;
  };

  start(): void {
    this.needsLogin = false;
    this.client.start();
  }

  stop(): void {
    this.closeMicrophone();
    this.engine?.player.stop();
    this.client.stop();
  }

  /** The tab is visible again or the network came back. */
  wake(): void {
    this.client.retryNow();
    void this.engine?.resume().catch(() => undefined);
  }

  sendText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const conversationId = this.client.conversationId;
    if (!conversationId) return this.refuse("No hay conexión: el mensaje no se envió.");
    this.interruptAssistant("superseded");
    const turnId = this.newId();
    const replyMode = this.micOpen && this.capabilities?.tts ? "voice" : "text";
    if (!this.client.send({ type: "user.text", conversationId, turnId, text: trimmed, replyMode })) {
      return this.refuse("No hay conexión: el mensaje no se envió.");
    }
    this.thread = reduceThread(this.thread, { type: "local.user", turnId, text: trimmed }, this.isoNow());
    this.markTurnSent(turnId, "thinking", replyMode === "voice");
    this.emit();
    return true;
  }

  stopAll(): void {
    const capturing = this.captureTurn;
    const turnId = capturing ?? this.activeTurn ?? this.engine?.player.turnId ?? null;
    this.voice.cancel();
    this.captureTurn = null;
    this.interruptAssistant("user_stop", turnId);
    this.closeMicrophone();
    this.emit();
  }

  async toggleMicrophone(): Promise<void> {
    if (this.micOpen) {
      this.stopAll();
      return;
    }
    if (!this.capabilities?.stt) {
      this.setNotice("warning", "La voz todavía no está disponible en el servidor. Escribime.");
      return;
    }
    if (this.micStarting) return;
    this.micStarting = true;
    try {
      const engine = this.ensureEngine();
      await engine.resume();
      await engine.startMicrophone((pcm) => this.voice.push(pcm));
      this.micOpen = true;
      this.voice.startWindow(INITIAL_LISTEN_MS);
    } catch (error) {
      this.setNotice("warning", micMessage(error));
    } finally {
      this.micStarting = false;
      this.emit();
    }
  }

  async enableAudio(): Promise<void> {
    await this.ensureEngine().resume().catch(() => undefined);
    this.emit();
  }

  decide(actionId: string, decision: "confirm" | "reject"): void {
    if (!this.client.send({ type: "action.decide", actionId, decision })) this.refuse("No hay conexión: la decisión no se envió.");
  }

  newConversation(): void {
    this.stopAll();
    this.client.send({ type: "conversation.new" });
  }

  loadOlder(): void {
    const conversationId = this.client.conversationId;
    const oldest = this.thread.messages.find((message) => !message.local);
    if (!conversationId || !oldest || !this.thread.hasMore || this.thread.loadingOlder) return;
    if (!this.client.send({ type: "history.fetch", conversationId, beforeMessageId: oldest.id, limit: HISTORY_PAGE })) return;
    this.thread = reduceThread(this.thread, { type: "local.older" }, this.isoNow());
    this.emit();
  }

  async enablePush(): Promise<PushResult> {
    const key = this.capabilities?.pushPublicKey;
    if (!key || !this.deps.subscribePush) return { ok: false, message: "Las notificaciones no están configuradas en el servidor." };
    const result = await this.deps.subscribePush(key);
    if (!result.ok || !result.subscription) return { ok: false, message: result.ok ? "No se pudo activar." : result.message };
    this.client.send({ type: "push.subscribe", subscription: result.subscription });
    return { ok: true };
  }

  /** Shows the outcome of a connection flow in the thread once the conversation has loaded. */
  showIntegrationResult(result: IntegrationResult): void {
    this.pendingCards.push(integrationResultCard(result));
    this.flushLocalCards();
    this.emit();
  }

  dismissNotice(): void {
    if (!this.notice) return;
    this.notice = null;
    this.emit();
  }

  registerPlayer(requestId: string, handle: PlayerHandle): () => void {
    this.players.set(requestId, handle);
    const pending = this.pendingCommands.get(requestId);
    if (pending) {
      this.pendingCommands.delete(requestId);
      this.runCommand(pending);
    }
    return () => void (this.players.get(requestId) === handle && this.players.delete(requestId));
  }

  reportPlayer(requestId: string, videoId: string, state: PlayerReport): void {
    this.client.send({ type: "player.state", requestId, videoId, state });
  }

  private newId(): string {
    return this.deps.newId?.() ?? crypto.randomUUID();
  }

  private nowMs(): number {
    return this.deps.now?.() ?? performance.now();
  }

  private isoNow(): string {
    return new Date().toISOString();
  }

  private refuse(text: string): false {
    this.setNotice("warning", text);
    return false;
  }

  private setNotice(level: Notice["level"], text: string): void {
    this.notice = { id: ++this.noticeCount, level, text };
    this.emit();
  }

  private ensureEngine(): AudioEngine {
    if (this.engine) return this.engine;
    const engine = this.deps.createEngine({
      leadSeconds: PLAYBACK_LEAD_SECONDS,
      onFirstAudio: (turnId, startsAt) => this.onFirstAudio(turnId, startsAt),
      onDrained: () => this.onDrained(),
    });
    engine.onRunningChange(() => this.emit());
    this.engine = engine;
    return engine;
  }

  private async shouldReconnect(info: CloseInfo): Promise<boolean> {
    if (info.wasReady && info.code !== SESSION_EXPIRED_CLOSE_CODE) return true;
    const valid = (await this.deps.isSessionValid?.()) ?? true;
    if (valid) return true;
    this.needsLogin = true;
    this.emit();
    return false;
  }

  private onStatus(status: ConnectionStatus): void {
    this.status = status;
    if (status !== "ready") {
      this.voice.cancel();
      this.captureTurn = null;
      this.engine?.player.stop();
      this.voice.setPlaying(false);
      this.serverState = "idle";
      this.activeTurn = null;
    }
    this.emit();
  }

  private flushLocalCards(): void {
    if (!this.thread.conversationId || this.thread.awaitingInitial) return;
    for (const card of this.pendingCards.splice(0)) this.thread = reduceThread(this.thread, { type: "local.card", card }, this.isoNow());
  }

  private onMessage(message: ServerMessage): void {
    if (threadEventTypes.has(message.type)) this.thread = reduceThread(this.thread, message as ThreadEvent, this.isoNow());
    if (message.type === "history") this.flushLocalCards();
    switch (message.type) {
      case "ready":
        this.capabilities = message.capabilities;
        this.ownerName = message.owner.displayName;
        this.thread = reduceThread(this.thread, message, this.isoNow());
        this.rearm();
        break;
      case "state":
        this.serverState = message.state;
        if (message.turnId) this.activeTurn = message.turnId;
        if (message.state === "idle") this.activeTurn = null;
        if (message.state === "idle") this.rearm();
        break;
      case "assistant.delta":
        this.recordFirstText(message.turnId);
        break;
      case "turn.end":
        this.onTurnEnd(message.turnId, message.status);
        break;
      case "audio.begin":
        this.onSpeechBegin(message.turnId, message.format.sampleRate);
        break;
      case "audio.end":
        this.engine?.player.end(message.turnId);
        this.reportMetrics(message.turnId, true);
        break;
      case "player.command":
        this.runCommand(message);
        break;
      case "conversation.end":
        this.closeMicrophone();
        break;
      case "notice":
        this.setNotice(message.level === "warning" ? "warning" : "info", message.message);
        break;
      case "error":
        if (!message.turnId) this.setNotice("error", message.message);
        break;
      default:
        break;
    }
    this.emit();
  }

  private onSpeechBegin(turnId: string, sampleRate: number): void {
    if (!this.client.audioGate.accepts(turnId)) return;
    const engine = this.ensureEngine();
    engine.player.begin(turnId, sampleRate);
    this.voice.setPlaying(true);
    this.audioWanted = true;
  }

  private onFirstAudio(turnId: string, startsAt: number): void {
    const timing = this.timings.get(turnId);
    if (timing && this.engine) {
      timing.firstAudioMs = Math.max(0, Math.round(this.nowMs() - timing.inputEndedAt + (startsAt - this.engine.currentTime) * 1000));
      this.reportMetrics(turnId);
    }
    this.emit();
  }

  private onDrained(): void {
    this.voice.setPlaying(false);
    this.audioWanted = false;
    this.rearm();
    this.emit();
  }

  private onTurnEnd(turnId: string, status: "completed" | "cancelled" | "failed"): void {
    if (this.activeTurn === turnId) this.activeTurn = null;
    const timing = this.timings.get(turnId);
    if (!timing) return;
    timing.ended = true;
    if (status === "completed") this.reportMetrics(turnId);
    else this.timings.delete(turnId);
  }

  private markTurnSent(turnId: string, state: ServerAssistantState, voice: boolean): void {
    this.activeTurn = turnId;
    this.serverState = state;
    this.timings.set(turnId, { inputEndedAt: this.nowMs(), voice, ended: false });
  }

  private recordFirstText(turnId: string): void {
    const timing = this.timings.get(turnId);
    if (timing && timing.firstTextMs === undefined) timing.firstTextMs = Math.round(this.nowMs() - timing.inputEndedAt);
  }

  private reportMetrics(turnId: string, force = false): void {
    const timing = this.timings.get(turnId);
    if (!timing?.ended) return;
    if (timing.voice && timing.firstAudioMs === undefined && !force) return;
    this.timings.delete(turnId);
    if (timing.firstAudioMs === undefined && timing.firstTextMs === undefined) return;
    this.client.send({
      type: "client.metrics",
      turnId,
      ...(timing.firstAudioMs === undefined ? {} : { firstAudioMs: timing.firstAudioMs }),
      ...(timing.firstTextMs === undefined ? {} : { firstTextMs: timing.firstTextMs }),
    });
  }

  private runCommand(command: PlayerCommand): void {
    if (command.action === "open") return;
    const handle = this.players.get(command.requestId);
    if (!handle) {
      this.pendingCommands.set(command.requestId, command);
      return;
    }
    if (command.action === "play") handle.play();
    else handle.pause();
  }

  private interruptAssistant(reason: "user_stop" | "barge_in" | "superseded", target = this.activeTurn): void {
    const speaking = this.engine?.player.turnId ?? null;
    this.engine?.player.stop();
    this.voice.setPlaying(false);
    this.audioWanted = false;
    if (speaking) this.client.audioGate.cancel(speaking);
    if (target) this.client.send({ type: "turn.cancel", turnId: target, reason });
    this.activeTurn = null;
    this.serverState = "idle";
  }

  private beginUtterance(): boolean {
    const conversationId = this.client.conversationId;
    if (!conversationId || this.status !== "ready") return false;
    this.interruptAssistant("barge_in");
    const turnId = this.newId();
    const replyMode = this.capabilities?.tts ? "voice" : "text";
    if (!this.client.send({ type: "audio.begin", conversationId, turnId, format: STT_INPUT_FORMAT, replyMode })) return false;
    this.captureTurn = turnId;
    this.emit();
    return true;
  }

  private sendFrame(pcm: Int16Array): void {
    if (!this.captureTurn) return;
    if (this.client.sendAudio(this.captureTurn, pcm16ToBytes(pcm))) return;
    this.voice.cancel();
    this.captureTurn = null;
    this.emit();
  }

  private endUtterance(): void {
    const turnId = this.captureTurn;
    this.captureTurn = null;
    if (!turnId) return;
    this.client.send({ type: "audio.end", turnId });
    this.markTurnSent(turnId, "transcribing", this.capabilities?.tts === true);
    this.emit();
  }

  private rearm(): void {
    const idle = this.serverState === "idle" && !this.engine?.player.active && !this.captureTurn;
    if (!this.micOpen || !idle) return;
    const followUp = this.capabilities?.followUpWindowMs ?? 0;
    if (followUp > 0) this.voice.startWindow(followUp);
    else this.closeMicrophone();
  }

  private closeMicrophone(): void {
    if (!this.micOpen) return;
    this.voice.clearWindow();
    this.voice.cancel();
    this.engine?.stopMicrophone();
    this.micOpen = false;
    this.inputLevel = 0;
    this.emit();
  }

  private buildSnapshot(): SessionSnapshot {
    const state = deriveState({
      connection: this.status,
      server: this.serverState,
      capturing: this.captureTurn !== null,
      micOpen: this.micOpen,
      playing: this.engine?.player.active === true,
    });
    return {
      connection: this.status,
      state,
      busy: isBusy(state, this.captureTurn !== null),
      thread: this.thread,
      capabilities: this.capabilities,
      ownerName: this.ownerName,
      micOpen: this.micOpen,
      audioBlocked: this.audioWanted && this.engine !== null && !this.engine.running,
      notice: this.notice,
      needsLogin: this.needsLogin,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function micMessage(error: unknown): string {
  if (error instanceof MicError && error.reason === "denied") {
    return "No tengo permiso para usar el micrófono. Habilitalo en los ajustes del navegador o escribime.";
  }
  return "No pude abrir el micrófono. Probá de nuevo o escribime.";
}
