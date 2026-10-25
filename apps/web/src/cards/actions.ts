import type { PlayerHandle, PlayerReport, PushResult } from "../conversation/session.js";

/** What cards may ask of the conversation. */
export interface CardActions {
  decide(actionId: string, decision: "confirm" | "reject"): void;
  registerPlayer(requestId: string, handle: PlayerHandle): () => void;
  reportPlayer(requestId: string, videoId: string, state: PlayerReport): void;
  enablePush(): Promise<PushResult>;
}
