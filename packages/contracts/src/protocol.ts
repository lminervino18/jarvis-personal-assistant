import { z } from "zod";
import { AudioFormat } from "./audio.js";
import { Card, TaskCard } from "./cards.js";
import { ReplyMode, ServerAssistantState } from "./states.js";
import { TaskCardAction } from "./tasks.js";

export const PROTOCOL_VERSION = 1;

const Id = z.uuid();

export const ClientKind = z.enum(["web", "device", "simulator"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  client: z.object({ kind: ClientKind, version: z.string().max(40) }),
  audio: z.object({
    input: z.array(AudioFormat).max(4),
    output: z.array(AudioFormat).max(4),
  }),
  conversationId: Id.optional(),
  /** Devices that cannot show a thread send false to skip the history page. */
  history: z.boolean().optional(),
});

export const UserTextMessage = z
  .object({
    type: z.literal("user.text"),
    conversationId: Id,
    turnId: Id,
    text: z.string().trim().max(4000),
    replyMode: ReplyMode,
    /** Files the owner uploaded with `POST /api/attachments` for this message. */
    attachments: z.array(Id).max(4).optional(),
  })
  .refine((message) => message.text.length > 0 || (message.attachments?.length ?? 0) > 0, "empty message");

export const AudioBeginMessage = z.object({
  type: z.literal("audio.begin"),
  conversationId: Id,
  turnId: Id,
  format: AudioFormat,
  replyMode: ReplyMode,
  /** `dictation` only transcribes: the server answers with the final transcript and starts no turn. */
  purpose: z.enum(["turn", "dictation"]).optional(),
  /** Speech heard while the assistant's reply was playing: a barge-in candidate the server may discard as backchannel. */
  duringPlayback: z.boolean().optional(),
});

/**
 * The owner went quiet inside an utterance; the server decides with the words whether the turn ended.
 * A tentative pause comes earlier and only lets the server start transcribing in advance.
 */
export const AudioPauseMessage = z.object({ type: z.literal("audio.pause"), turnId: Id, tentative: z.boolean().optional() });

/** The owner kept talking after a pause, so the same turn continues. */
export const AudioResumeMessage = z.object({ type: z.literal("audio.resume"), turnId: Id });

export const AudioEndMessage = z.object({
  type: z.literal("audio.end"),
  turnId: Id,
});

export const TurnCancelMessage = z.object({
  type: z.literal("turn.cancel"),
  turnId: Id,
  reason: z.enum(["user_stop", "barge_in", "superseded"]),
});

export const ActionDecisionMessage = z.object({
  type: z.literal("action.decide"),
  actionId: Id,
  decision: z.enum(["confirm", "reject"]),
});

export const PlayerStateMessage = z.object({
  type: z.literal("player.state"),
  requestId: z.string().max(64),
  videoId: z.string().max(16),
  state: z.enum(["ready", "playing", "paused", "ended", "blocked", "error"]),
});

export const ClientMetricsMessage = z.object({
  type: z.literal("client.metrics"),
  turnId: Id,
  /** Milliseconds from the end of user input (audio.end or user.text sent) to first audible output. */
  firstAudioMs: z.number().nonnegative().max(600_000).optional(),
  /** Milliseconds from the end of user input to first rendered assistant text. */
  firstTextMs: z.number().nonnegative().max(600_000).optional(),
});

export const ConversationNewMessage = z.object({ type: z.literal("conversation.new") });

export const HistoryFetchMessage = z.object({
  type: z.literal("history.fetch"),
  conversationId: Id,
  beforeMessageId: z.string().optional(),
  limit: z.number().int().min(1).max(100),
});

export const PushSubscribeMessage = z.object({
  type: z.literal("push.subscribe"),
  subscription: z.object({
    endpoint: z.url().max(1000),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  }),
});

/** An owner decision on a task card. It never goes through the model. */
export const TaskActionMessage = z.object({
  type: z.literal("task.action"),
  taskId: Id,
  action: TaskCardAction,
  approvalId: Id.optional(),
});

/** Opens or refreshes build mode: the server answers with `build.tasks`. */
export const BuildListMessage = z.object({ type: z.literal("build.list") });

/** A change the owner wants in JARVIS itself; it becomes a task on the jarvis project without going through the model. */
export const BuildRequestMessage = z.object({ type: z.literal("build.request"), text: z.string().trim().min(1).max(4000) });

/** An answer or a change request for a build task. */
export const BuildFeedbackMessage = z.object({ type: z.literal("build.feedback"), taskId: Id, text: z.string().trim().min(1).max(4000) });

const Pixels = z.number().int().min(0).max(10_000);

/** Layout measurements from the device, logged to diagnose how the app fills the screen. No personal data. */
export const ClientViewportMessage = z.object({
  type: z.literal("client.viewport"),
  standalone: z.boolean(),
  inner: Pixels,
  client: Pixels,
  visual: Pixels,
  screen: Pixels,
  app: Pixels,
  safeTop: Pixels,
  safeBottom: Pixels,
});
export type ViewportReport = Omit<z.infer<typeof ClientViewportMessage>, "type">;

const AudioProcessing = z.object({
  echoCancellation: z.boolean().optional(),
  noiseSuppression: z.boolean().optional(),
  autoGainControl: z.boolean().optional(),
});

/** Microphone processing the browser supports and what it actually applied, so requested is not mistaken for effective. */
export const ClientAudioMessage = z.object({
  type: z.literal("client.audio"),
  supported: AudioProcessing,
  applied: AudioProcessing.extend({ sampleRate: z.number().optional(), channelCount: z.number().optional() }),
  contextSampleRate: z.number(),
  /** Which speech detector the client runs: Silero, or the volume fallback. */
  detector: z.enum(["silero", "energy"]).optional(),
});

export type CaptureReport = Omit<z.infer<typeof ClientAudioMessage>, "type">;

/** Whether this client is in a voice call, so the server can say background news aloud. */
export const CallStateMessage = z.object({ type: z.literal("call.state"), active: z.boolean() });

/** The owner is about to talk or type: the server can warm the model's prompt cache meanwhile. */
export const WarmMessage = z.object({ type: z.literal("warm") });

export const PingMessage = z.object({ type: z.literal("ping"), t: z.number() });

export const ClientMessage = z.discriminatedUnion("type", [
  HelloMessage,
  UserTextMessage,
  AudioBeginMessage,
  AudioPauseMessage,
  AudioResumeMessage,
  AudioEndMessage,
  TurnCancelMessage,
  ActionDecisionMessage,
  PlayerStateMessage,
  ClientMetricsMessage,
  ConversationNewMessage,
  HistoryFetchMessage,
  PushSubscribeMessage,
  TaskActionMessage,
  BuildListMessage,
  BuildRequestMessage,
  BuildFeedbackMessage,
  ClientViewportMessage,
  ClientAudioMessage,
  WarmMessage,
  CallStateMessage,
  PingMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const HistoryItem = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  at: z.iso.datetime({ offset: true }),
  interrupted: z.boolean(),
  cards: z.array(Card),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

export const ErrorCode = z.enum([
  "unauthorized",
  "bad_request",
  "rate_limited",
  "busy",
  "quota_exceeded",
  "claude_auth_failed",
  "claude_unavailable",
  "stt_failed",
  "tts_failed",
  "tool_failed",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const ServerBase = z.object({ seq: z.number().int().nonnegative() });

export const ServerMessage = z.discriminatedUnion("type", [
  ServerBase.extend({
    type: z.literal("ready"),
    protocol: z.literal(PROTOCOL_VERSION),
    conversationId: Id,
    owner: z.object({ displayName: z.string() }),
    capabilities: z.object({
      stt: z.boolean(),
      tts: z.boolean(),
      ttsProvider: z.string().nullable(),
      outputFormat: AudioFormat.nullable(),
      followUpWindowMs: z.number().int().nonnegative(),
      pushPublicKey: z.string().nullable(),
      /** The server recognizes the owner's voice in calls and drops other voices itself. */
      speakerCheck: z.boolean().optional(),
    }),
  }),
  ServerBase.extend({
    type: z.literal("history"),
    conversationId: Id,
    items: z.array(HistoryItem),
    hasMore: z.boolean(),
  }),
  ServerBase.extend({
    type: z.literal("state"),
    state: ServerAssistantState,
    turnId: Id.optional(),
    tool: z.string().optional(),
  }),
  ServerBase.extend({ type: z.literal("transcript"), turnId: Id, text: z.string(), final: z.boolean() }),
  ServerBase.extend({ type: z.literal("assistant.delta"), turnId: Id, text: z.string() }),
  ServerBase.extend({
    type: z.literal("assistant.done"),
    turnId: Id,
    messageId: z.string(),
    text: z.string(),
    interrupted: z.boolean(),
  }),
  ServerBase.extend({
    type: z.literal("tool"),
    turnId: Id,
    toolUseId: z.string(),
    name: z.string(),
    phase: z.enum(["start", "end"]),
    ok: z.boolean().optional(),
  }),
  ServerBase.extend({ type: z.literal("card"), turnId: Id.optional(), card: Card }),
  ServerBase.extend({ type: z.literal("audio.begin"), turnId: Id, format: AudioFormat, processed: z.boolean() }),
  ServerBase.extend({
    type: z.literal("audio.end"),
    turnId: Id,
    reason: z.enum(["complete", "cancelled", "error"]),
  }),
  ServerBase.extend({
    type: z.literal("player.command"),
    requestId: z.string(),
    action: z.enum(["open", "play", "pause"]),
    videoId: z.string().optional(),
  }),
  ServerBase.extend({
    type: z.literal("turn.end"),
    turnId: Id,
    status: z.enum(["completed", "cancelled", "failed"]),
    errorCode: ErrorCode.optional(),
  }),
  ServerBase.extend({
    type: z.literal("conversation.end"),
    conversationId: Id,
    reason: z.enum(["farewell", "timeout"]),
  }),
  ServerBase.extend({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string(),
    turnId: Id.optional(),
    retryable: z.boolean(),
  }),
  ServerBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning"]),
    code: z.string(),
    message: z.string(),
  }),
  ServerBase.extend({ type: z.literal("build.tasks"), tasks: z.array(TaskCard).max(50) }),
  ServerBase.extend({ type: z.literal("pong"), t: z.number() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A server message before the connection assigns its sequence number. */
export type OutgoingServerMessage = DistributiveOmit<ServerMessage, "seq">;
