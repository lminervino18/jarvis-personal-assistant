import type { TaskCardAction } from "@jarvis/contracts";
import type { PlayerHandle, PlayerReport, PushResult } from "../conversation/session.js";

/** What cards may ask of the conversation. */
export interface CardActions {
  decide(actionId: string, decision: "confirm" | "reject"): void;
  registerPlayer(requestId: string, handle: PlayerHandle): () => void;
  reportPlayer(requestId: string, videoId: string, state: PlayerReport): void;
  enablePush(): Promise<PushResult>;
  taskAction(taskId: string, action: TaskCardAction, approvalId?: string): void;
  /** Sends a message as if the owner had written it, such as their pick from a card. */
  say(text: string): void;
}
