import { createHash, randomUUID } from "node:crypto";
import {
  stateChangingTools,
  toolInputs,
  untrustedContentTools,
  type ConfirmCard,
  type ToolName,
  type ToolResult,
} from "@jarvis/contracts";
import { z } from "zod";
import { fail } from "./envelope.js";
import type { AnyToolDefinition, ToolContext } from "./types.js";

const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

type ConfirmCardValue = z.infer<typeof ConfirmCard>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function idempotencyKey(turnId: string, tool: ToolName, input: unknown): string {
  return createHash("sha256").update(`${turnId}|${tool}|${stableStringify(input)}`).digest("hex");
}

function parseInput(definition: AnyToolDefinition, raw: unknown) {
  return z.object(toolInputs[definition.name]).strict().safeParse(raw ?? {});
}

async function executeOnce(ctx: ToolContext, definition: AnyToolDefinition, input: unknown): Promise<ToolResult<unknown>> {
  const { db } = ctx.services;
  const key = idempotencyKey(ctx.turnId, definition.name, input);
  const cached = db.prepare("SELECT result_json FROM tool_executions WHERE idempotency_key = ?").get(key) as
    | { result_json: string }
    | undefined;
  if (cached) return JSON.parse(cached.result_json) as ToolResult<unknown>;

  const result = await (definition.execute as (c: ToolContext, i: unknown) => Promise<ToolResult<unknown>>)(ctx, input);
  if (result.ok) {
    db.prepare(
      "INSERT OR IGNORE INTO tool_executions (idempotency_key, tool, turn_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(key, definition.name, ctx.turnId, JSON.stringify(result), new Date().toISOString());
  }
  return result;
}

function requestConfirmation(ctx: ToolContext, definition: AnyToolDefinition, input: unknown): ToolResult<unknown> {
  const describe = definition.describe as ((c: ToolContext, i: unknown) => ConfirmCardValue | undefined) | undefined;
  const summary = describe?.(ctx, input) ?? { title: definition.name, summary: "Acción pendiente", details: [] };
  const id = randomUUID();
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + PENDING_ACTION_TTL_MS).toISOString();
  ctx.services.db
    .prepare(
      `INSERT INTO pending_actions (id, conversation_id, turn_id, tool, input_json, title, summary, details_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      ctx.conversationId,
      ctx.turnId,
      definition.name,
      JSON.stringify(input),
      summary.title,
      summary.summary,
      JSON.stringify(summary.details),
      now.toISOString(),
      expiresAt,
    );
  ctx.emitCard({ kind: "confirm", actionId: id, ...summary, expiresAt, status: "pending" });
  return fail(
    "needs_confirmation",
    "Esta acción proviene de un turno que leyó contenido de terceros. Quedó pendiente de confirmación del dueño en la tarjeta.",
    false,
    id,
  );
}

/**
 * Runs a tool call with backend-enforced policy: schema validation, confirmation for
 * state changes after untrusted content, idempotent writes, and taint tracking.
 */
export async function runTool(ctx: ToolContext, definition: AnyToolDefinition, raw: unknown): Promise<ToolResult<unknown>> {
  const parsed = parseInput(definition, raw);
  if (!parsed.success) return fail("invalid_input", z.prettifyError(parsed.error));

  const changesState = stateChangingTools.has(definition.name);
  if (changesState && ctx.security.tainted) return requestConfirmation(ctx, definition, parsed.data);

  try {
    const result = changesState
      ? await executeOnce(ctx, definition, parsed.data)
      : await (definition.execute as (c: ToolContext, i: unknown) => Promise<ToolResult<unknown>>)(ctx, parsed.data);
    if (untrustedContentTools.has(definition.name)) {
      ctx.security.tainted = true;
      ctx.security.taintSources.add(definition.name);
    }
    return result;
  } catch (error) {
    console.error(`tool ${definition.name} failed:`, error instanceof Error ? error.message : "unknown error");
    return fail("internal", "La herramienta falló de forma inesperada.", true);
  }
}

export interface PendingActionOutcome {
  status: "executed" | "failed" | "rejected" | "expired" | "not_found";
  result?: ToolResult<unknown>;
  tool?: ToolName;
  card?: ConfirmCardValue;
}

/**
 * Applies the owner's decision on a pending action. Execution reuses the stored input
 * verbatim and never involves the model.
 */
export async function decidePendingAction(
  ctx: Omit<ToolContext, "turnId" | "conversationId" | "security">,
  definitions: ReadonlyMap<ToolName, AnyToolDefinition>,
  actionId: string,
  decision: "confirm" | "reject",
): Promise<PendingActionOutcome> {
  const { db } = ctx.services;
  const row = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(actionId) as
    | {
        id: string;
        conversation_id: string;
        turn_id: string;
        tool: ToolName;
        input_json: string;
        title: string;
        summary: string;
        details_json: string;
        status: string;
        expires_at: string;
      }
    | undefined;
  if (!row || row.status !== "pending") return { status: "not_found" };

  const card = (status: ConfirmCardValue["status"]): ConfirmCardValue => ({
    kind: "confirm",
    actionId: row.id,
    title: row.title,
    summary: row.summary,
    details: JSON.parse(row.details_json) as ConfirmCardValue["details"],
    expiresAt: row.expires_at,
    status,
  });
  const now = ctx.now();
  const setStatus = (status: string, result?: ToolResult<unknown>) =>
    db
      .prepare("UPDATE pending_actions SET status = ?, decided_at = ?, result_json = ? WHERE id = ? AND status = 'pending'")
      .run(status, now.toISOString(), result ? JSON.stringify(result) : null, row.id);

  if (new Date(row.expires_at) <= now) {
    setStatus("expired");
    return { status: "expired", tool: row.tool, card: card("expired") };
  }
  if (decision === "reject") {
    setStatus("rejected");
    return { status: "rejected", tool: row.tool, card: card("rejected") };
  }

  const definition = definitions.get(row.tool);
  if (!definition) return { status: "not_found" };
  const claimed = db
    .prepare("UPDATE pending_actions SET status = 'executed', decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(now.toISOString(), row.id);
  if (claimed.changes === 0) return { status: "not_found" };

  const turnCtx: ToolContext = {
    ...ctx,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    security: { tainted: false, taintSources: new Set() },
  };
  const result = await executeOnce(turnCtx, definition, JSON.parse(row.input_json));
  db.prepare("UPDATE pending_actions SET status = ?, result_json = ? WHERE id = ?").run(
    result.ok ? "executed" : "failed",
    JSON.stringify(result),
    row.id,
  );
  return { status: result.ok ? "executed" : "failed", result, tool: row.tool, card: card(result.ok ? "confirmed" : "failed") };
}
