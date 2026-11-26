import { z } from "zod";

/**
 * Where one tool execution stands. `preparing` is the model composing the call, `running` is the
 * call dispatched to execution, `waiting` is a running call that is taking long, and `needs_approval`
 * is a call stopped until the owner decides. Every phase after `waiting` is final.
 */
export const ActivityPhase = z.enum(["preparing", "running", "waiting", "needs_approval", "succeeded", "failed", "cancelled"]);
export type ActivityPhase = z.infer<typeof ActivityPhase>;

export const finalActivityPhases: ReadonlySet<ActivityPhase> = new Set(["needs_approval", "succeeded", "failed", "cancelled"]);

/** Measured progress only: it is sent when a tool reports it, never estimated. */
export const ActivityProgress = z.object({ done: z.number().nonnegative(), total: z.number().positive() });

/**
 * One change in a tool execution. `version` grows by one per change of the same `executionId`, so a
 * duplicate or late event is recognizable; `at` is the server clock in epoch milliseconds. It carries
 * no tool arguments and no content: the client renders its own text from `tool` and `phase`.
 */
export const ActivityEvent = z.object({
  conversationId: z.uuid(),
  turnId: z.uuid(),
  executionId: z.string().max(100),
  tool: z.string().max(100),
  phase: ActivityPhase,
  version: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  progress: ActivityProgress.optional(),
  taskId: z.uuid().optional(),
  actionId: z.uuid().optional(),
  errorCode: z.string().max(40).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;
