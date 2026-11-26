import { finalActivityPhases, type ActivityEvent, type ActivityPhase } from "@jarvis/contracts";

/** `interrupted` is the connection dropping while the call was open: the call itself did not fail. */
export type ExecutionPhase = ActivityPhase | "interrupted";

export interface ExecutionView {
  id: string;
  tool: string;
  phase: ExecutionPhase;
  version: number;
  errorCode?: string;
}

export interface TurnActivityView {
  turnId: string;
  executions: readonly ExecutionView[];
  /** `thinking` until the reply starts, `replying` while it is written, `ended` after the turn. */
  stage: "thinking" | "replying" | "ended";
  outcome?: "completed" | "cancelled" | "failed";
}

const MAX_TURNS = 30;
const MAX_EXECUTIONS = 40;

function isFinal(phase: ExecutionPhase): boolean {
  return phase === "interrupted" || finalActivityPhases.has(phase);
}

/**
 * What the tools of each turn are doing, as the server reported it. It lives apart from the thread so
 * that an update re-renders only the activity of its own turn, and it keeps a bounded history.
 */
export class ActivityStore {
  private readonly turns = new Map<string, TurnActivityView>();
  private readonly listeners = new Set<() => void>();
  private ids: readonly string[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  turn = (turnId: string): TurnActivityView | undefined => this.turns.get(turnId);

  /** The ids of the turns that have activity; the array changes only when a turn is added or dropped. */
  turnIds = (): readonly string[] => this.ids;

  /** The turn working now, if any. */
  current = (): TurnActivityView | undefined => {
    for (let index = this.ids.length - 1; index >= 0; index--) {
      const turn = this.turns.get(this.ids[index] as string);
      if (turn && turn.stage !== "ended") return turn;
    }
    return undefined;
  };

  begin(turnId: string): void {
    if (!this.turns.has(turnId)) this.put({ turnId, executions: [], stage: "thinking" });
  }

  replying(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn?.stage === "thinking") this.put({ ...turn, stage: "replying" });
  }

  apply(event: ActivityEvent): void {
    const turn = this.turns.get(event.turnId) ?? { turnId: event.turnId, executions: [], stage: "thinking" as const };
    if (turn.stage === "ended") return;
    const index = turn.executions.findIndex((execution) => execution.id === event.executionId);
    const known = turn.executions[index];
    if (known && (event.version <= known.version || isFinal(known.phase))) return;
    const next: ExecutionView = { id: event.executionId, tool: event.tool, phase: event.phase, version: event.version, ...(event.errorCode ? { errorCode: event.errorCode } : {}) };
    const executions = known ? turn.executions.map((execution, at) => (at === index ? next : execution)) : [...turn.executions, next];
    this.put({ ...turn, executions: executions.length > MAX_EXECUTIONS ? dropOldestFinal(executions) : executions });
  }

  /** The turn is over: whatever is still open is closed, and later events for it are ignored. */
  end(turnId: string, status: "completed" | "cancelled" | "failed"): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.stage === "ended") return;
    const open: ExecutionPhase = status === "failed" ? "failed" : "cancelled";
    this.put({ ...turn, stage: "ended", outcome: status, executions: turn.executions.map((execution) => (isFinal(execution.phase) ? execution : { ...execution, phase: open })) });
  }

  /** The connection dropped: open calls are shown as interrupted, not failed. */
  connectionLost(): void {
    for (const turn of this.turns.values()) {
      if (turn.stage === "ended" || !turn.executions.some((execution) => !isFinal(execution.phase))) continue;
      this.put({ ...turn, executions: turn.executions.map((execution) => (isFinal(execution.phase) ? execution : { ...execution, phase: "interrupted" as const })) });
    }
  }

  /**
   * The connection is back: a turn that was still running is forgotten, because the server describes
   * what is still running again right after, and what finished is in the history.
   */
  reconnected(): void {
    for (const turn of [...this.turns.values()]) if (turn.stage !== "ended") this.turns.delete(turn.turnId);
    this.refreshIds();
    this.notify();
  }

  private put(turn: TurnActivityView): void {
    const isNew = !this.turns.has(turn.turnId);
    this.turns.set(turn.turnId, turn);
    if (isNew) {
      this.trim();
      this.refreshIds();
    }
    this.notify();
  }

  private trim(): void {
    for (const turnId of this.turns.keys()) {
      if (this.turns.size <= MAX_TURNS) return;
      if (this.turns.get(turnId)?.stage === "ended") this.turns.delete(turnId);
    }
  }

  private refreshIds(): void {
    this.ids = [...this.turns.keys()];
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function dropOldestFinal(executions: ExecutionView[]): ExecutionView[] {
  const index = executions.findIndex((execution) => isFinal(execution.phase));
  return index < 0 ? executions : executions.filter((_, at) => at !== index);
}
