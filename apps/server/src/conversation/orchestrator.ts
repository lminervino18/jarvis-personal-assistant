import { randomUUID } from "node:crypto";
import type { Card, ErrorCode, ModelRuntime, OutgoingServerMessage, ReplyMode, RuntimeErrorCode, TurnStatus } from "@jarvis/contracts";
import { createTurnToolServer, qualifiedToolName } from "../tools/mcp-server.js";
import { decidePendingAction } from "../tools/runner.js";
import type { AnyToolDefinition, ToolContext, ToolServices, TurnSecurityState } from "../tools/types.js";
import type { ReplySpeaker } from "../voice/types.js";
import type { ConversationStore } from "./conversation-store.js";
import type { ConversationHub } from "./hub.js";
import type { TurnToolRegistry } from "./turn-tool-registry.js";

export interface Logger {
  info(data: object, message?: string): void;
  warn(data: object, message?: string): void;
  error(data: object, message?: string): void;
}

export interface OrchestratorDeps {
  store: ConversationStore;
  hub: ConversationHub;
  runtime: ModelRuntime;
  toolRegistry: TurnToolRegistry;
  services: ToolServices;
  tools: readonly AnyToolDefinition[];
  builtinTools: readonly string[];
  ownerName: string;
  sessionMaxTurns: number;
  /** Taint sources whose content must never reach the voice provider (e.g. email over an external TTS). */
  textOnlySources?: ReadonlySet<string>;
  log: Logger;
  now?: () => Date;
}

export interface StartTurnInput {
  conversationId: string;
  turnId: string;
  text: string;
  inputMode: ReplyMode;
  replyMode: ReplyMode;
  /** performance.now() when the owner's input ended (end of speech or text sent). */
  inputEndedAt: number;
  sttMs?: number;
  createSpeaker?: (signal: AbortSignal) => ReplySpeaker | undefined;
}

interface ActiveTurn {
  turnId: string;
  conversationId: string;
  controller: AbortController;
  reason?: string;
}

interface TurnOutcome {
  text: string;
  sessionId?: string;
  errorCode?: RuntimeErrorCode;
  errorMessage?: string;
  retryAfterMs?: number;
  usedTools: boolean;
  firstTextAt?: number;
}

const SUMMARY_PROMPT =
  "Resumí esta conversación para continuarla en una sesión nueva: temas, decisiones, acuerdos (indicando si están propuestos o confirmados), pendientes y lo que el dueño pidió recordar. Indicá de dónde salió cada dato (dicho por el dueño, correo, WhatsApp, web). Máximo 12 líneas, sin agregar nada que no esté en la conversación.";

const FAREWELL =/\b(gracias,?\s+jarvis|terminamos|eso es todo|nada m[aá]s,?\s+gracias)\b/i;

const runtimeErrorToProtocol: Record<RuntimeErrorCode, ErrorCode> = {
  cancelled: "internal",
  quota_exceeded: "quota_exceeded",
  auth_failed: "claude_auth_failed",
  resume_failed: "claude_unavailable",
  unavailable: "claude_unavailable",
  internal: "internal",
};

function failureMessage(outcome: TurnOutcome, timezone: string): string {
  switch (outcome.errorCode) {
    case "quota_exceeded": {
      const resetsAt = outcome.retryAfterMs
        ? new Date(Date.now() + outcome.retryAfterMs).toLocaleTimeString("es-AR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" })
        : undefined;
      return `Se agotó la cuota de Claude por ahora${resetsAt ? `; se restablece cerca de las ${resetsAt}` : ""}. Los recordatorios existentes siguen funcionando.`;
    }
    case "auth_failed":
      return "No pude autenticarme con Claude. Hay que renovar la conexión de la suscripción en el servidor.";
    default:
      return "No pude completar la respuesta por un problema con Claude. Probá de nuevo en un momento.";
  }
}

/**
 * Runs conversation turns: one active turn per conversation, explicit session resume,
 * rotation to a fresh seeded session, durable persistence, and event fan-out.
 */
export class ConversationOrchestrator {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly byTurn = new Map<string, ActiveTurn>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: OrchestratorDeps) {}

  activeTurn(conversationId: string): string | undefined {
    return this.active.get(conversationId)?.turnId;
  }

  startTurn(input: StartTurnInput): Promise<void> {
    const conversationId = input.conversationId;
    if (this.byTurn.has(input.turnId)) return Promise.resolve();
    const finished = this.deps.store.getTurn(input.turnId);
    if (finished) {
      this.replayFinishedTurn(input.turnId, conversationId, finished);
      return Promise.resolve();
    }
    const previous = this.active.get(conversationId);
    if (previous) this.cancel(previous.turnId, "superseded");

    const active: ActiveTurn = { turnId: input.turnId, conversationId, controller: new AbortController() };
    this.active.set(conversationId, active);
    this.byTurn.set(input.turnId, active);

    const prior = this.chains.get(conversationId) ?? Promise.resolve();
    const settled = prior
      .then(() => this.executeTurn(input, active))
      .catch((error: unknown) => {
        this.deps.log.error({ turnId: input.turnId, err: error instanceof Error ? error.message : "unknown" }, "turn crashed");
      })
      .finally(() => {
        this.byTurn.delete(input.turnId);
        if (this.active.get(conversationId) === active) this.active.delete(conversationId);
        if (this.chains.get(conversationId) === settled) this.chains.delete(conversationId);
      });
    this.chains.set(conversationId, settled);
    return settled;
  }

  cancel(turnId: string, reason: string): boolean {
    const active = this.byTurn.get(turnId);
    if (!active) return false;
    active.reason ??= reason;
    active.controller.abort();
    return true;
  }

  async decideAction(actionId: string, decision: "confirm" | "reject"): Promise<void> {
    const { services, tools, store, hub } = this.deps;
    const conversationId = (
      services.db.prepare("SELECT conversation_id FROM pending_actions WHERE id = ?").get(actionId) as
        | { conversation_id: string }
        | undefined
    )?.conversation_id;
    if (!conversationId) return;
    const emitCard = (card: Card) => hub.emit(conversationId, { type: "card", card });
    const outcome = await decidePendingAction(
      { services, now: () => this.now(), emitCard, emitPlayerCommand: () => {} },
      new Map(tools.map((tool) => [tool.name, tool])),
      actionId,
      decision,
    );
    if (!outcome.card) return;
    emitCard(outcome.card);
    const text =
      outcome.status === "executed"
        ? `Confirmado: ${outcome.card.title}.`
        : outcome.status === "rejected"
          ? `Descartado: ${outcome.card.title}.`
          : outcome.status === "expired"
            ? `La confirmación de "${outcome.card.title}" expiró.`
            : `No se pudo completar: ${outcome.card.title}.`;
    const item = store.appendMessage({ conversationId, turnId: null, role: "system", content: text, cards: [outcome.card] });
    hub.emit(conversationId, { type: "history", conversationId, items: [item], hasMore: false });
  }

  /** A client retrying a turn id it already sent gets the stored outcome instead of a second run. */
  private replayFinishedTurn(turnId: string, conversationId: string, turn: { conversationId: string; status: TurnStatus }): void {
    const { hub, store } = this.deps;
    if (turn.conversationId !== conversationId || turn.status === "running") return;
    hub.emit(conversationId, { type: "history", conversationId, items: store.turnMessages(turnId), hasMore: false });
    hub.emit(conversationId, { type: "turn.end", turnId, status: turn.status });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Before rotating a long session, asks Claude for a sourced summary of it so the next
   * session keeps decisions and pending items. Failure only means a thinner seed.
   */
  private async summarizeSession(conversationId: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const turnId = randomUUID();
    const security: TurnSecurityState = { tainted: false, taintSources: new Set() };
    this.deps.toolRegistry.register(turnId, { server: createTurnToolServer(this.noToolContext(conversationId, turnId, security), []), allowedTools: [], security });
    let summary = "";
    try {
      for await (const event of this.deps.runtime.runTurn({
        conversationId,
        turnId,
        text: SUMMARY_PROMPT,
        replyMode: "text",
        resumeSessionId: sessionId,
        signal,
      })) {
        if (event.type === "text_delta") summary += event.text;
        if (event.type === "error") summary = "";
      }
    } finally {
      this.deps.toolRegistry.release(turnId);
    }
    if (summary.trim()) this.deps.store.setSummary(conversationId, summary.trim().slice(0, 4000));
    this.deps.store.setSession(conversationId, null, 0);
  }

  private noToolContext(conversationId: string, turnId: string, security: TurnSecurityState): ToolContext {
    return {
      services: this.deps.services,
      conversationId,
      turnId,
      now: () => this.now(),
      security,
      emitCard: () => {},
      emitPlayerCommand: () => {},
    };
  }

  private async executeTurn(input: StartTurnInput, active: ActiveTurn): Promise<void> {
    const { store, hub, sessionMaxTurns, ownerName } = this.deps;
    const { conversationId, turnId } = input;
    const emit = (message: OutgoingServerMessage) => hub.emit(conversationId, message);
    const signal = active.controller.signal;

    let conversation = store.get(conversationId);
    if (!conversation) throw new Error("conversation not found");
    if (conversation.claude_session_id && conversation.session_turns >= sessionMaxTurns && !signal.aborted) {
      await this.summarizeSession(conversationId, conversation.claude_session_id, signal);
      conversation = store.get(conversationId) ?? conversation;
    }
    const canResume = conversation.claude_session_id !== null && conversation.session_turns < sessionMaxTurns;
    let resumeSessionId = canResume ? (conversation.claude_session_id as string) : undefined;
    let seedContext = resumeSessionId ? undefined : store.seedContext(conversationId, ownerName);

    store.startTurn({ id: turnId, conversationId, inputMode: input.inputMode, replyMode: input.replyMode, sttMs: input.sttMs });
    const userItem = store.appendMessage({ conversationId, turnId, role: "user", content: input.text });
    store.setTitleIfEmpty(conversationId, input.text);
    emit({ type: "history", conversationId, items: [userItem], hasMore: false });

    const security: TurnSecurityState = { tainted: false, taintSources: new Set() };
    const cards: Card[] = [];
    const ctx: ToolContext = {
      services: this.deps.services,
      conversationId,
      turnId,
      now: () => this.now(),
      security,
      emitCard: (card) => {
        cards.push(card);
        emit({ type: "card", turnId, card });
      },
      emitPlayerCommand: (command) => emit({ type: "player.command", ...command }),
    };
    this.deps.toolRegistry.register(turnId, {
      server: createTurnToolServer(ctx, this.deps.tools),
      allowedTools: [...this.deps.tools.map((tool) => qualifiedToolName(tool.name)), ...this.deps.builtinTools],
      security,
    });

    const voice = { speaker: input.createSpeaker?.(signal) };
    const keepSensitiveAsText = () => {
      const textOnly = this.deps.textOnlySources;
      if (!voice.speaker || !textOnly || ![...security.taintSources].some((source) => textOnly.has(source))) return;
      voice.speaker.cancel();
      voice.speaker = undefined;
      emit({
        type: "notice",
        level: "info",
        code: "voice_text_only",
        message: "Te dejo esta respuesta por escrito porque incluye contenido de tus correos.",
      });
    };
    emit({ type: "state", state: "thinking", turnId });

    let outcome: TurnOutcome;
    try {
      outcome = await this.consume(input, resumeSessionId, seedContext, signal, emit, voice, keepSensitiveAsText);
      if (outcome.errorCode === "resume_failed" && !outcome.text && !signal.aborted) {
        this.deps.log.warn({ turnId }, "claude session could not be resumed; starting a seeded session");
        resumeSessionId = undefined;
        seedContext = store.seedContext(conversationId, ownerName);
        outcome = await this.consume(input, undefined, seedContext, signal, emit, voice, keepSensitiveAsText);
      }
    } finally {
      this.deps.toolRegistry.release(turnId);
    }

    const speaker = voice.speaker;
    const cancelled = signal.aborted || outcome.errorCode === "cancelled";
    if (outcome.sessionId) {
      const sessionTurns = resumeSessionId && outcome.sessionId === resumeSessionId ? conversation.session_turns + 1 : 1;
      store.setSession(conversationId, outcome.sessionId, sessionTurns);
    }

    let status: "completed" | "cancelled" | "failed";
    if (cancelled) {
      status = "cancelled";
      speaker?.cancel();
      const item = store.appendMessage({ conversationId, turnId, role: "assistant", content: outcome.text, cards, interrupted: true });
      emit({ type: "assistant.done", turnId, messageId: item.id, text: outcome.text, interrupted: true });
      emit({ type: "state", state: "interrupted", turnId });
    } else if (outcome.errorCode) {
      status = "failed";
      speaker?.cancel();
      const message = failureMessage(outcome, this.deps.services.timezone);
      this.deps.log.warn({ turnId, code: outcome.errorCode, detail: outcome.errorMessage?.slice(0, 200) }, "turn failed");
      store.appendMessage({ conversationId, turnId, role: "system", content: message, cards });
      emit({
        type: "error",
        code: runtimeErrorToProtocol[outcome.errorCode],
        message,
        turnId,
        retryable: outcome.errorCode !== "auth_failed",
      });
    } else {
      status = "completed";
      const item = store.appendMessage({ conversationId, turnId, role: "assistant", content: outcome.text, cards });
      emit({ type: "assistant.done", turnId, messageId: item.id, text: outcome.text, interrupted: false });
      if (speaker) {
        try {
          await speaker.finish();
        } catch (error) {
          this.deps.log.warn({ turnId, err: error instanceof Error ? error.message : "unknown" }, "speech synthesis failed");
          if (!signal.aborted) {
            emit({ type: "error", code: "tts_failed", message: "La voz falló; la respuesta quedó por escrito.", turnId, retryable: true });
          }
        }
        if (signal.aborted) {
          status = "cancelled";
          store.markInterrupted(item.id);
          emit({ type: "assistant.done", turnId, messageId: item.id, text: outcome.text, interrupted: true });
          emit({ type: "state", state: "interrupted", turnId });
        }
      }
    }

    store.finishTurn(
      turnId,
      { status, errorCode: outcome.errorCode, sessionId: outcome.sessionId, tainted: security.tainted, usedTools: outcome.usedTools },
      {
        firstTextMs: outcome.firstTextAt !== undefined ? Math.round(outcome.firstTextAt - input.inputEndedAt) : undefined,
        firstAudioMs: speaker?.firstAudioAt !== undefined ? Math.round(speaker.firstAudioAt - input.inputEndedAt) : undefined,
      },
    );
    emit({ type: "turn.end", turnId, status, ...(status === "failed" && outcome.errorCode ? { errorCode: runtimeErrorToProtocol[outcome.errorCode] } : {}) });
    emit({ type: "state", state: "idle" });
    if (status === "completed" && FAREWELL.test(input.text)) emit({ type: "conversation.end", conversationId, reason: "farewell" });
  }

  private async consume(
    input: StartTurnInput,
    resumeSessionId: string | undefined,
    seedContext: string | undefined,
    signal: AbortSignal,
    emit: (message: OutgoingServerMessage) => void,
    voice: { speaker?: ReplySpeaker },
    afterTool: () => void,
  ): Promise<TurnOutcome> {
    const outcome: TurnOutcome = { text: "", usedTools: false };
    const events = this.deps.runtime.runTurn({
      conversationId: input.conversationId,
      turnId: input.turnId,
      text: input.text,
      replyMode: input.replyMode,
      resumeSessionId,
      seedContext,
      signal,
    });
    for await (const event of events) {
      switch (event.type) {
        case "session":
          outcome.sessionId = event.sessionId;
          break;
        case "text_delta":
          outcome.firstTextAt ??= performance.now();
          outcome.text += event.text;
          emit({ type: "assistant.delta", turnId: input.turnId, text: event.text });
          voice.speaker?.textDelta(event.text);
          break;
        case "tool_start":
          outcome.usedTools = true;
          voice.speaker?.toolStarted();
          emit({ type: "tool", turnId: input.turnId, toolUseId: event.toolUseId, name: event.name, phase: "start" });
          emit({ type: "state", state: "using_tool", turnId: input.turnId, tool: event.name });
          break;
        case "tool_end":
          emit({ type: "tool", turnId: input.turnId, toolUseId: event.toolUseId, name: event.name, phase: "end", ok: !event.isError });
          afterTool();
          emit({ type: "state", state: "thinking", turnId: input.turnId });
          break;
        case "retry":
          if (event.attempt >= 2) emit({ type: "notice", level: "info", code: "claude_retry", message: "Claude está demorando; reintentando." });
          break;
        case "result":
          outcome.sessionId = event.sessionId;
          if (!outcome.text) outcome.text = event.text;
          break;
        case "error":
          outcome.errorCode = event.code;
          outcome.errorMessage = event.message;
          outcome.retryAfterMs = event.retryAfterMs;
          outcome.sessionId ??= event.sessionId;
          break;
      }
    }
    return outcome;
  }
}
