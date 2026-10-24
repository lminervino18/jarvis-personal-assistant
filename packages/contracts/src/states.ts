import { z } from "zod";

/**
 * Observable assistant states. Every state shown in the UI must originate from a real
 * event (backend message, microphone, or audio playback), never from a timer.
 */
export const assistantStates = [
  "offline",
  "connecting",
  "idle",
  "listening",
  "transcribing",
  "thinking",
  "using_tool",
  "speaking",
  "interrupted",
  "error",
] as const;

export const AssistantState = z.enum(assistantStates);
export type AssistantState = z.infer<typeof AssistantState>;

/** States the server is allowed to emit. The client owns offline, connecting and listening. */
export const ServerAssistantState = AssistantState.extract([
  "idle",
  "transcribing",
  "thinking",
  "using_tool",
  "speaking",
  "interrupted",
  "error",
]);
export type ServerAssistantState = z.infer<typeof ServerAssistantState>;

export const TurnStatus = z.enum(["running", "completed", "cancelled", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const ReplyMode = z.enum(["text", "voice"]);
export type ReplyMode = z.infer<typeof ReplyMode>;
