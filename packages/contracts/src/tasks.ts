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
export const TaskCardAction = z.enum(["pause", "resume", "cancel", "accept", "approve", "reject", "publish", "archive", "ship_pr", "ship_main", "ship_new"]);
export type TaskCardAction = z.infer<typeof TaskCardAction>;

/** Where a build task's change is on its way to production, after the owner taps Publish. */
export const PublicationStatus = z.enum(["queued", "running", "published", "failed"]);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

/**
 * Where a task's result goes: an existing GitHub repository (as a pull request or onto its base
 * branch), or a new project that gets its own private repository and a Vercel site.
 */
export const TaskTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), base: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("new"), name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/) }),
]);
export type TaskTarget = z.infer<typeof TaskTarget>;

export const ReviewVerdict = z.enum(["approve", "changes", "blocked"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;
