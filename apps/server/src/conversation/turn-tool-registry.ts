import type { TurnToolset } from "../runtime/claude-runtime.js";

/** Hands each running turn's toolset to the runtime without coupling the two. */
export class TurnToolRegistry {
  private readonly toolsets = new Map<string, TurnToolset>();

  register(turnId: string, toolset: TurnToolset): void {
    this.toolsets.set(turnId, toolset);
  }

  require(turnId: string): TurnToolset {
    const toolset = this.toolsets.get(turnId);
    if (!toolset) throw new Error(`no toolset registered for turn ${turnId}`);
    return toolset;
  }

  release(turnId: string): void {
    this.toolsets.delete(turnId);
  }
}
