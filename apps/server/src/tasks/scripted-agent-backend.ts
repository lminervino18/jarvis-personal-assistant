import type { AgentBackend, AgentRole, AgentRunRequest, AgentRunResult } from "./agent-backend.js";

export type ScriptedHandler = (request: AgentRunRequest, call: number) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>;

/**
 * Deterministic agent backend for tests and offline demos. It never contacts Claude:
 * each role is a function that may edit the workspace and returns the structured output.
 */
export class ScriptedAgentBackend implements AgentBackend {
  readonly name = "scripted";
  readonly runsCommands = true;
  readonly calls: { role: AgentRole; taskId: string; resumeSessionId?: string; maxBudgetUsd: number; planLimit: number; prompt: string }[] = [];
  private readonly counts = new Map<AgentRole, number>();

  constructor(private readonly handlers: Partial<Record<AgentRole, ScriptedHandler>>) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const call = (this.counts.get(request.role) ?? 0) + 1;
    this.counts.set(request.role, call);
    this.calls.push({ role: request.role, taskId: request.taskId, resumeSessionId: request.resumeSessionId, maxBudgetUsd: request.maxBudgetUsd, planLimit: request.planLimit, prompt: request.prompt });
    const handler = this.handlers[request.role];
    if (!handler) return { costUsd: 0, turns: 0, models: [], error: { code: "internal", message: `no script for ${request.role}` } };
    if (request.signal.aborted) return { costUsd: 0, turns: 0, models: [], error: { code: "cancelled", message: "Sesión cancelada" } };
    const partial = await handler(request, call);
    return {
      sessionId: `scripted-${request.role}-${request.taskId.slice(0, 8)}`,
      costUsd: 0.01,
      turns: 1,
      models: ["scripted-fixture"],
      ...partial,
    };
  }
}
