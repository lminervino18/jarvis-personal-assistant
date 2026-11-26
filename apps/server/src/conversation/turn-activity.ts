import { finalActivityPhases, type ActivityEvent, type ActivityPhase } from "@jarvis/contracts";
import { MCP_SERVER_NAME } from "../tools/mcp-server.js";

const PHASE_ORDER: Record<ActivityPhase, number> = {
  preparing: 0,
  running: 1,
  waiting: 2,
  needs_approval: 3,
  succeeded: 3,
  failed: 3,
  cancelled: 3,
};

interface Execution {
  tool: string;
  phase: ActivityPhase;
  version: number;
  timer?: NodeJS.Timeout;
}

export interface TurnActivityDeps {
  conversationId: string;
  turnId: string;
  send(event: ActivityEvent): void;
  now?: () => number;
  /** How long a running call goes before it is reported as waiting for its service. */
  waitingAfterMs?: number;
}

export const WAITING_AFTER_MS = 5000;

/** The tool's own name, without the prefix the Agent SDK adds to in-process tools. */
export function presentedToolName(name: string): string {
  return name.startsWith(`mcp__${MCP_SERVER_NAME}__`) ? name.slice(`mcp__${MCP_SERVER_NAME}__`.length) : name;
}

/**
 * Follows the tool executions of one turn and reports each change once, with a version per execution.
 * It only observes: sending is fire-and-forget and a failure to send never reaches the turn.
 */
export class TurnActivity {
  private readonly executions = new Map<string, Execution>();

  constructor(private readonly deps: TurnActivityDeps) {}

  preparing(executionId: string, name: string): void {
    this.move(executionId, name, "preparing");
  }

  running(executionId: string, name: string): void {
    this.move(executionId, name, "running");
  }

  ended(executionId: string, name: string, result: { isError: boolean; errorCode?: string }): void {
    if (result.errorCode === "needs_confirmation") return this.move(executionId, name, "needs_approval");
    this.move(executionId, name, result.isError ? "failed" : "succeeded", result.isError ? { errorCode: result.errorCode ?? "tool_failed" } : {});
  }

  /** Closes what is still open when the turn ends, so nothing stays active after it. */
  settle(status: "completed" | "cancelled" | "failed"): void {
    for (const [id, execution] of this.executions) {
      if (!finalActivityPhases.has(execution.phase)) this.move(id, execution.tool, status === "failed" ? "failed" : "cancelled");
    }
  }

  /** The executions still in progress, for a client that connects in the middle of the turn. */
  open(): ActivityEvent[] {
    return [...this.executions].filter(([, execution]) => !finalActivityPhases.has(execution.phase)).map(([id, execution]) => this.event(id, execution));
  }

  private move(executionId: string, name: string, phase: ActivityPhase, extra: Partial<ActivityEvent> = {}): void {
    const tool = presentedToolName(name);
    const current = this.executions.get(executionId);
    if (current && PHASE_ORDER[phase] <= PHASE_ORDER[current.phase]) return;
    if (current && finalActivityPhases.has(current.phase)) return;
    const execution: Execution = { tool, phase, version: (current?.version ?? 0) + 1 };
    if (current?.timer) clearTimeout(current.timer);
    if (phase === "running") execution.timer = this.waitTimer(executionId, tool);
    this.executions.set(executionId, execution);
    this.send({ ...this.event(executionId, execution), ...extra });
  }

  private waitTimer(executionId: string, tool: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.move(executionId, tool, "waiting"), this.deps.waitingAfterMs ?? WAITING_AFTER_MS);
    timer.unref();
    return timer;
  }

  private event(executionId: string, execution: Execution): ActivityEvent {
    const { conversationId, turnId, now } = this.deps;
    return { conversationId, turnId, executionId, tool: execution.tool, phase: execution.phase, version: execution.version, at: (now ?? Date.now)() };
  }

  private send(event: ActivityEvent): void {
    try {
      this.deps.send(event);
    } catch {
      return;
    }
  }
}
