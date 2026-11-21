import { z } from "zod";

/**
 * Lifecycle of a delegated task. `queued` and `running` belong to the agent runner,
 * `awaiting_owner` and `ready` wait for the owner, the last three are final.
 */
export const TaskStatus = z.enum(["queued", "running", "awaiting_owner", "ready", "accepted", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const finalTaskStatuses: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["accepted", "failed", "cancelled"]);

/** The phase the runner executes next, or is executing. */
export const TaskPhase = z.enum(["plan", "execute", "review"]);
export type TaskPhase = z.infer<typeof TaskPhase>;

/** Why a task waits for the owner. */
export const TaskBlockerKind = z.enum(["question", "approval", "review_limit", "budget", "usage_limit", "error"]);
export type TaskBlockerKind = z.infer<typeof TaskBlockerKind>;

export const TaskBlocker = z.object({
  kind: TaskBlockerKind,
  message: z.string(),
  approvalId: z.uuid().optional(),
});
export type TaskBlocker = z.infer<typeof TaskBlocker>;

/** What the owner can do from a task card, without going through the model. */
export const TaskCardAction = z.enum(["pause", "resume", "cancel", "accept", "approve", "reject"]);
export type TaskCardAction = z.infer<typeof TaskCardAction>;

export const ReviewVerdict = z.enum(["approve", "changes", "blocked"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
