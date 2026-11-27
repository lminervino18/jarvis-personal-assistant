import {
  MAX_TEXT_CHARS,
  STT_INPUT_FORMAT,
  type AssistantState,
  type AudioFormat,
  type Card,
  type ClientMessage,
  type ReplyMode,
  type ServerAssistantState,
  type ServerMessage,
  type TaskCardAction,
  type ViewportReport,
} from "@jarvis/contracts";
import { ActivityStore } from "../activity/activity-store.js";
import { MicError, type AudioEngine } from "../audio/engine.js";
import { levelFromDbfs, pcm16ToBytes, rmsDbfs } from "../audio/pcm.js";
import type { PcmPlayerOptions } from "../audio/playback.js";
import { VoiceLoop, type DetectorFactory } from "../audio/voice-loop.js";
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
  /** Replies to typed and dictated messages are spoken. A call always speaks. */
  speakerOn: boolean;
  callActive: boolean;
  callMuted: boolean;
  dictation: "idle" | "recording" | "transcribing";
  /** The latest dictated text; `id` changes with every new transcript, `send` asks the composer to send it right away. */
  dictated: { id: number; text: string; send: boolean } | null;
  audioBlocked: boolean;
  notice: Notice | null;
  needsLogin: boolean;
  /** Build mode tasks, newest first; null until build mode is opened. */
  buildTasks: BuildTask[] | null;
}

export type BuildTask = Extract<Card, { kind: "task" }>;

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
  /** Loads the Silero speech detector; without it the volume fallback is used. */
  loadDetectors?(): Promise<DetectorFactory>;
}

interface TurnTiming {
  inputEndedAt: number;
  voice: boolean;
  firstTextMs?: number;
  firstAudioMs?: number;
  ended: boolean;
}

const MAX_VIEWPORT_REPORTS = 6;
const MAX_CAPTURE_REPORTS = 3;
const INITIAL_LISTEN_MS = 12_000;
const CALL_LISTEN_MS = 5 * 60_000;
const SPEAKER_KEY = "jarvis.speaker";
const PLAYBACK_LEAD_SECONDS = 0.12;
const HISTORY_PAGE = 40;
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const tooLong = (text: string) =>
  `El mensaje es muy largo: tiene ${text.length.toLocaleString("es-AR")} caracteres y el máximo es ${MAX_TEXT_CHARS.toLocaleString("es-AR")}. No se envió.`;

const OUTPUT_FORMATS: AudioFormat[] = [24000, 16000, 22050, 48000].map((sampleRate) => ({
  encoding: "pcm_s16le",
  sampleRate: sampleRate as AudioFormat["sampleRate"],
  channels: 1,
}));

const threadEventTypes = new Set<ServerMessage["type"]>(["history", "assistant.delta", "assistant.done", "card", "transcript", "error", "turn.end"]);

/** Owns one conversation with the server: protocol, thread, microphone, playback and the derived UI state. */
export class Session {
  /** What the tools of each turn are doing; it notifies on its own so the thread does not re-render with it. */
  readonly activity = new ActivityStore();
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
  private speakerOn = readSpeakerPreference();
  private callActive = false;
  private callMuted = false;
  private dictationWanted = false;
  private dictation: SessionSnapshot["dictation"] = "idle";
  private dictationTurn: string | null = null;
  private readonly dictationTurns = new Set<string>();
  private dictated: SessionSnapshot["dictated"] = null;
  private dictationSend = false;
  private sample: Int16Array[] | null = null;
  private sampling = false;
  private audioWanted = false;
  private needsLogin = false;
  private notice: Notice | null = null;
  private buildTasks: BuildTask[] | null = null;
  private viewportReports = 0;
  private captureReports = 0;
  private bargeCandidate: string | null = null;
  private pausedAt: number | null = null;
  private detector: "silero" | "energy" = "energy";
  private detectorsLoading = false;
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
      onHint: () => this.captureTurn && this.client.send({ type: "audio.pause", turnId: this.captureTurn, tentative: true }),
      onPause: () => this.notifyPause(),
      onResume: () => this.captureTurn && this.client.send({ type: "audio.resume", turnId: this.captureTurn }),
      onConfirmed: () => this.confirmBargeIn(),
      onEnd: () => this.endUtterance(),
      onLevel: (level) => void (this.inputLevel = level),
      onTimeout: () => (this.callActive ? this.voice.startWindow(CALL_LISTEN_MS) : this.closeMicrophone()),
    });
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  getLevels = (): Levels => {
    this.levels.input = this.micOpen || this.dictation === "recording" || this.sampling ? this.inputLevel : 0;
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

  /** Sends a typed message, optionally with attachments already uploaded with `POST /api/attachments`. */
  say(text: string): void {
    this.sendText(text);
  }

  sendText(text: string, attachments: readonly Extract<Card, { kind: "attachment" }>[] = []): boolean {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return false;
    if (trimmed.length > MAX_TEXT_CHARS) return this.refuse(tooLong(trimmed));
    const conversationId = this.client.conversationId;
    if (!conversationId) return this.refuse("No hay conexión: el mensaje no se envió.");
    this.interruptAssistant("superseded");
    const turnId = this.newId();
    const replyMode = this.replyMode();
    const ids = attachments.map((card) => card.attachmentId);
    if (!this.client.send({ type: "user.text", conversationId, turnId, text: trimmed, replyMode, ...(ids.length ? { attachments: ids } : {}) })) {
      return this.refuse("No hay conexión: el mensaje no se envió.");
    }
    this.thread = reduceThread(this.thread, { type: "local.user", turnId, text: trimmed, cards: [...attachments] }, this.isoNow());
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
    await this.openMicrophone(INITIAL_LISTEN_MS);
  }

  /** Hands-free conversation: the microphone stays open and every reply is spoken until the call ends. */
  async startCall(): Promise<void> {
    if (this.callActive) return;
    this.engine?.stopClip?.();
    this.callActive = true;
    this.callMuted = false;
    this.emit();
    if (!this.micOpen) await this.openMicrophone(CALL_LISTEN_MS);
    if (!this.micOpen) this.callActive = false;
    this.client.send({ type: "call.state", active: this.callActive });
    this.emit();
  }

  endCall(): void {
    if (!this.callActive) return;
    this.callActive = false;
    this.callMuted = false;
    this.client.send({ type: "call.state", active: false });
    this.stopAll();
  }

  /**
   * Plays the welcome through the session's own output, so the core speaks with it. Answers false
   * when the browser still holds the sound; called again from the owner's touch, it plays.
   */
  async playWelcome(data: ArrayBuffer): Promise<boolean> {
    const engine = this.ensureEngine();
    if (!engine.playClip) return true;
    await engine.resume().catch(() => undefined);
    if (!engine.running) return false;
    await engine.playClip(data, () => this.emit()).catch(() => undefined);
    this.emit();
    return true;
  }

  async toggleCallMute(): Promise<void> {
    if (!this.callActive) return;
    if (this.callMuted) {
      this.callMuted = false;
      await this.openMicrophone(CALL_LISTEN_MS);
      if (!this.micOpen) this.callMuted = true;
      this.emit();
      return;
    }
    this.callMuted = true;
    if (this.captureTurn) this.interruptAssistant("user_stop", this.captureTurn);
    this.captureTurn = null;
    this.closeMicrophone();
  }

  toggleSpeaker(): void {
    this.speakerOn = !this.speakerOn;
    writeSpeakerPreference(this.speakerOn);
    if (!this.speakerOn && !this.callActive) this.silencePlayback();
    this.emit();
  }

  /** Dictation: records until stopped and writes the transcript into the composer instead of sending a turn. */
  async startDictation(): Promise<void> {
    if (!this.canRecord()) return;
    this.dictationWanted = true;
    const turnId = await this.openRecorder(() => this.dictationWanted);
    if (!turnId) return;
    this.dictationTurn = turnId;
    this.dictationTurns.add(turnId);
    this.dictation = "recording";
    this.emit();
  }

  /**
   * Stops dictating; the transcript arrives later in the snapshot's `dictated`. With `send` the
   * composer sends it as soon as it arrives instead of leaving it for editing.
   */
  stopDictation(send = false): void {
    this.dictationWanted = false;
    if (this.dictation !== "recording" || !this.dictationTurn) return;
    this.dictationSend = send;
    this.closeRecorderMicrophone();
    this.client.send({ type: "audio.end", turnId: this.dictationTurn });
    this.dictation = "transcribing";
    this.emit();
  }

  /** Records a voice sample for training: 16 kHz PCM kept on the device until `stopSample`. */
  async startSample(): Promise<boolean> {
    if (this.micOpen || this.dictation !== "idle" || this.micStarting || this.sample) return false;
    const chunks: Int16Array[] = [];
    this.sample = chunks;
    this.micStarting = true;
    try {
      const engine = this.ensureEngine();
      await engine.resume();
      await engine.startMicrophone((pcm) => {
        this.inputLevel = levelFromDbfs(rmsDbfs(pcm));
        chunks.push(pcm.slice());
      });
      this.sampling = true;
      return true;
    } catch (error) {
      this.sample = null;
      this.setNotice("warning", micMessage(error));
      return false;
    } finally {
      this.micStarting = false;
      this.emit();
    }
  }

  stopSample(): Int16Array {
    const chunks = this.sample ?? [];
    this.sample = null;
    this.sampling = false;
    this.engine?.stopMicrophone();
    this.inputLevel = 0;
    this.emit();
    const samples = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return samples;
  }

  private canRecord(): boolean {
    if (this.micOpen || this.dictation !== "idle" || this.micStarting) return false;
    if (!this.capabilities?.stt) {
      this.setNotice("warning", "La voz todavía no está disponible en el servidor. Escribime.");
      return false;
    }
    if (!this.client.conversationId || this.status !== "ready") return this.refuse("No hay conexión: no puedo escucharte.");
    return true;
  }

  /** Opens the microphone and starts a dictation capture; returns its turn id, or null if it was abandoned or failed. */
  private async openRecorder(wanted: () => boolean): Promise<string | null> {
    const conversationId = this.client.conversationId;
    if (!conversationId) return null;
    this.micStarting = true;
    try {
      const engine = this.ensureEngine();
      await engine.resume();
      await engine.startMicrophone((pcm) => {
        this.inputLevel = levelFromDbfs(rmsDbfs(pcm));
        this.sendFrame(pcm);
      });
      this.reportCapture();
      if (!wanted()) {
        engine.stopMicrophone();
        return null;
      }
      const turnId = this.newId();
      const begin = { type: "audio.begin", conversationId, turnId, format: STT_INPUT_FORMAT, replyMode: this.replyMode(), purpose: "dictation" } as const;
      if (!this.client.send(begin)) {
        engine.stopMicrophone();
        this.refuse("No hay conexión: no puedo escucharte.");
        return null;
      }
      this.captureTurn = turnId;
      return turnId;
    } catch (error) {
      this.setNotice("warning", micMessage(error));
      return null;
    } finally {
      this.micStarting = false;
      this.emit();
    }
  }

  /** Throws the dictation away, including a transcript still on its way. */
  cancelDictation(): void {
    this.dictationWanted = false;
    if (this.dictation === "recording" && this.dictationTurn) {
      this.client.send({ type: "turn.cancel", turnId: this.dictationTurn, reason: "user_stop" });
      this.closeRecorderMicrophone();
    }
    this.dictation = "idle";
    this.dictationTurn = null;
    this.emit();
  }

  private closeRecorderMicrophone(): void {
    this.engine?.stopMicrophone();
    this.inputLevel = 0;
    this.captureTurn = null;
  }

  private onDictationMessage(message: ServerMessage & { turnId: string }): void {
    if (message.type === "transcript" && !message.final) return;
    this.dictationTurns.delete(message.turnId);
    if (message.turnId !== this.dictationTurn) return;
    if (this.dictation === "recording") this.closeRecorderMicrophone();
    this.dictation = "idle";
    this.dictationTurn = null;
    if (message.type === "transcript" && message.text) this.dictated = { id: (this.dictated?.id ?? 0) + 1, text: message.text, send: this.dictationSend };
    else if (message.type === "transcript") this.setNotice("info", "No te escuché. Probá de nuevo.");
    else if (message.type === "error") this.setNotice("warning", message.message);
    this.emit();
  }

  async enableAudio(): Promise<void> {
    await this.ensureEngine().resume().catch(() => undefined);
    this.emit();
  }

  decide(actionId: string, decision: "confirm" | "reject"): void {
    if (!this.client.send({ type: "action.decide", actionId, decision })) this.refuse("No hay conexión: la decisión no se envió.");
  }

  taskAction(taskId: string, action: TaskCardAction, approvalId?: string): void {
    if (!this.client.send({ type: "task.action", taskId, action, ...(approvalId ? { approvalId } : {}) })) {
      this.refuse("No hay conexión: la acción sobre la tarea no se envió.");
    }
  }

  /** Sends layout measurements for diagnosis, a few times per page load at most. */
  private reportCapture(): void {
    const report = this.engine?.captureReport?.();
    if (!report || this.captureReports >= MAX_CAPTURE_REPORTS) return;
    if (this.client.send({ type: "client.audio", ...report, detector: this.detector })) this.captureReports += 1;
  }

  /** Loads Silero once; until it is ready (or if it cannot run) the volume detector keeps working. */
  private loadDetectors(): void {
    const load = this.deps.loadDetectors;
    if (!load || this.detector === "silero" || this.detectorsLoading) return;
    this.detectorsLoading = true;
    load()
      .then((detectors) => {
        this.voice.useDetectors(detectors);
        this.detector = "silero";
        this.reportCapture();
      })
      .catch(() => {
        this.detectorsLoading = false;
      });
  }

  reportViewport(report: ViewportReport): void {
    if (this.viewportReports >= MAX_VIEWPORT_REPORTS) return;
    if (this.client.send({ type: "client.viewport", ...report })) this.viewportReports += 1;
  }

  /** The owner is about to talk or type: lets the server warm the model meanwhile. */
  warm(): void {
    this.client.send({ type: "warm" });
  }

  /** Asks for the build mode task list; the answer arrives as `build.tasks`. */
  refreshBuild(): void {
    this.client.send({ type: "build.list" });
  }

  /** A change the owner wants in JARVIS itself. Returns false when it could not be sent. */
  requestBuild(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length > MAX_TEXT_CHARS) return this.refuse(tooLong(trimmed));
    if (!this.client.send({ type: "build.request", text: trimmed })) return this.refuse("No hay conexión: el pedido no se envió.");
    return true;
  }

  buildFeedback(taskId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.length > MAX_TEXT_CHARS) return this.refuse(tooLong(trimmed));
    if (!this.client.send({ type: "build.feedback", taskId, text: trimmed })) return this.refuse("No hay conexión: la respuesta no se envió.");
    return true;
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
      this.activity.connectionLost();
      if (this.dictation === "recording") this.engine?.stopMicrophone();
      this.dictation = "idle";
      this.dictationTurn = null;
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
    if (message.type === "activity") {
      this.activity.apply(message);
      return;
    }
    if ("turnId" in message && message.turnId && this.dictationTurns.has(message.turnId)) {
      this.onDictationMessage(message as ServerMessage & { turnId: string });
      return;
    }
    if (threadEventTypes.has(message.type)) this.thread = reduceThread(this.thread, message as ThreadEvent, this.isoNow());
    if (message.type === "history") this.flushLocalCards();
    switch (message.type) {
      case "ready":
        this.activity.reconnected();
        this.capabilities = message.capabilities;
        this.ownerName = message.owner.displayName;
        this.thread = reduceThread(this.thread, message, this.isoNow());
        if (this.callActive) this.client.send({ type: "call.state", active: true });
        this.rearm();
        break;
      case "state":
        if (message.state === "transcribing" && message.turnId) this.onUtteranceClosed(message.turnId);
        this.serverState = message.state;
        if (message.turnId) this.activeTurn = message.turnId;
        if (message.state === "thinking" && message.turnId) this.activity.begin(message.turnId);
        if (message.state === "idle") this.activeTurn = null;
        if (message.state === "idle") this.rearm();
        break;
      case "assistant.delta":
        this.activity.replying(message.turnId);
        this.recordFirstText(message.turnId);
        break;
      case "turn.end":
        this.activity.end(message.turnId, message.status);
        if (message.turnId === this.captureTurn) this.onUtteranceClosed(message.turnId);
        if (message.turnId === this.bargeCandidate) this.dropBargeCandidate();
        this.onTurnEnd(message.turnId, message.status);
        break;
      case "transcript":
        if (!message.final) break;
        if (message.turnId === this.captureTurn) this.onUtteranceClosed(message.turnId);
        if (message.turnId === this.bargeCandidate && message.text.trim()) this.confirmBargeIn();
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
        if (this.callActive) this.client.send({ type: "call.state", active: false });
        this.callActive = false;
        this.callMuted = false;
        this.closeMicrophone();
        break;
      case "notice":
        this.setNotice(message.level === "warning" ? "warning" : "info", message.message);
        break;
      case "build.tasks":
        this.buildTasks = message.tasks;
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
    if (this.bargeCandidate) this.engine?.duck?.(false);
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

  private markTurnSent(turnId: string, state: ServerAssistantState, voice: boolean, inputEndedAt = this.nowMs()): void {
    this.activeTurn = turnId;
    this.serverState = state;
    this.timings.set(turnId, { inputEndedAt, voice, ended: false });
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

  /**
   * Speech started. Over a playing reply it is only a candidate: the reply is lowered, not stopped,
   * until the speech lasts (onConfirmed) or the server hears real words; a backchannel restores it.
   */
  private beginUtterance(): boolean {
    const conversationId = this.client.conversationId;
    if (!conversationId || this.status !== "ready") return false;
    const overReply = this.engine?.player.active === true;
    const turnId = this.newId();
    const replyMode = this.capabilities?.tts ? "voice" : "text";
    const begin = { type: "audio.begin", conversationId, turnId, format: STT_INPUT_FORMAT, replyMode, ...(overReply ? { duringPlayback: true } : {}) } as const;
    if (!this.client.send(begin)) return false;
    this.captureTurn = turnId;
    this.pausedAt = null;
    if (overReply) {
      this.bargeCandidate = turnId;
      this.engine?.duck?.(true);
    }
    this.emit();
    return true;
  }

  private notifyPause(): void {
    if (!this.captureTurn) return;
    this.pausedAt = this.nowMs();
    this.client.send({ type: "audio.pause", turnId: this.captureTurn });
  }

  /** The candidate turned out to be the owner talking: stop the reply for good. */
  /** Long speech over the reply cuts it here, unless the server checks voices: then only its verdict does. */
  private confirmBargeIn(): void {
    if (!this.bargeCandidate || this.capabilities?.speakerCheck) return;
    this.bargeCandidate = null;
    this.interruptAssistant("barge_in");
    this.engine?.duck?.(false);
    this.emit();
  }

  /** The candidate was a backchannel or noise: the reply goes on at full volume, from where it was. */
  private dropBargeCandidate(): void {
    this.bargeCandidate = null;
    this.engine?.duck?.(false);
  }

  /** The server closed the utterance at a pause: stop streaming it and wait for the reply. */
  private onUtteranceClosed(turnId: string): void {
    if (this.captureTurn !== turnId) return;
    this.voice.cancel();
    this.captureTurn = null;
    if (this.bargeCandidate === turnId) return;
    this.markTurnSent(turnId, "transcribing", this.capabilities?.tts === true, this.pausedAt ?? undefined);
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
    if (this.callActive) {
      this.voice.startWindow(CALL_LISTEN_MS);
      return;
    }
    const followUp = this.capabilities?.followUpWindowMs ?? 0;
    if (followUp > 0) this.voice.startWindow(followUp);
    else this.closeMicrophone();
  }

  private replyMode(): ReplyMode {
    return this.capabilities?.tts && (this.callActive || this.speakerOn) ? "voice" : "text";
  }

  private async openMicrophone(windowMs: number): Promise<void> {
    if (!this.capabilities?.stt) {
      this.setNotice("warning", "La voz todavía no está disponible en el servidor. Escribime.");
      return;
    }
    this.warm();
    if (this.micStarting) return;
    this.micStarting = true;
    try {
      const engine = this.ensureEngine();
      await engine.resume();
      await engine.startMicrophone((pcm) => this.voice.push(pcm));
      this.reportCapture();
      this.loadDetectors();
      this.micOpen = true;
      this.voice.startWindow(windowMs);
    } catch (error) {
      this.setNotice("warning", micMessage(error));
    } finally {
      this.micStarting = false;
      this.emit();
    }
  }

  private silencePlayback(): void {
    const speaking = this.engine?.player.turnId ?? null;
    this.engine?.player.stop();
    if (speaking) this.client.audioGate.cancel(speaking);
    this.voice.setPlaying(false);
    this.audioWanted = false;
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
      playing: this.engine?.player.active === true || this.engine?.clipPlaying === true,
    });
    return {
      connection: this.status,
      state,
      busy: isBusy(state, this.captureTurn !== null),
      thread: this.thread,
      capabilities: this.capabilities,
      ownerName: this.ownerName,
      micOpen: this.micOpen,
      speakerOn: this.speakerOn,
      callActive: this.callActive,
      callMuted: this.callMuted,
      dictation: this.dictation,
      dictated: this.dictated,
      audioBlocked: this.audioWanted && this.engine !== null && !this.engine.running,
      notice: this.notice,
      needsLogin: this.needsLogin,
      buildTasks: this.buildTasks,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function readSpeakerPreference(): boolean {
  try {
    return localStorage.getItem(SPEAKER_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSpeakerPreference(on: boolean): void {
  try {
    localStorage.setItem(SPEAKER_KEY, on ? "on" : "off");
  } catch {
    return;
  }
}

function micMessage(error: unknown): string {
  if (error instanceof MicError && error.reason === "denied") {
    return "No tengo permiso para usar el micrófono. Habilitalo en los ajustes del navegador o escribime.";
  }
  return "No pude abrir el micrófono. Probá de nuevo o escribime.";
}
