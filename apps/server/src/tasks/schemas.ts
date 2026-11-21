import { z } from "zod";

const Text = z.string().max(2000);
const Short = z.string().max(400);

/** What the planner must return before anything is executed. */
export const TaskSpec = z.object({
  goal: Text,
  deliverables: z.array(Short).max(10),
  acceptanceCriteria: z
    .array(z.object({ id: z.string().max(10), text: Short, verification: Short }))
    .min(1)
    .max(12),
  assumptions: z.array(Short).max(10),
  blockingQuestions: z.array(Short).max(5),
  externalEffects: z.array(Short).max(5),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

const CommandRun = z.object({ command: Short, exitCode: z.number().int(), summary: Short });

/** The executor's own account of an iteration. The reviewer treats it as claims, not facts. */
export const ExecutionReport = z.object({
  status: z.enum(["done", "blocked"]),
  summary: Text,
  changes: z.array(z.object({ path: Short, description: Short })).max(40),
  commandsRun: z.array(CommandRun).max(20),
  deliverables: z.array(z.object({ path: Short, description: Short })).max(20),
  criteria: z.array(z.object({ id: z.string().max(10), status: z.enum(["met", "not_met", "unsure"]), evidence: Short })).max(12),
  questions: z.array(Short).max(5),
  approvalsNeeded: z.array(z.object({ kind: z.enum(["deploy", "publish", "delete", "send", "production", "other"]), description: Short })).max(3),
});
export type ExecutionReport = z.infer<typeof ExecutionReport>;

/** The independent reviewer's verdict, criterion by criterion. */
export const ReviewResult = z.object({
  verdict: z.enum(["approve", "changes", "blocked"]),
  summary: Text,
  criteria: z.array(z.object({ id: z.string().max(10), status: z.enum(["pass", "fail", "unverified"]), evidence: Short })).max(12),
  requiredChanges: z.array(Short).max(10),
  checksRun: z.array(CommandRun).max(20),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

/** Facts the runner measures itself, independent of what any agent says. */
export interface TaskEvidence {
  iteration: number;
  changedFiles: string[];
  diffStat: string;
  diffPath: string;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}
