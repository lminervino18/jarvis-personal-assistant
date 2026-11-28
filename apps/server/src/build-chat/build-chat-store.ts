import type { Db } from "../db/database.js";

export type BuildRole = "owner" | "assistant" | "system";

export interface BuildMessage {
  id: number;
  role: BuildRole;
  text: string;
  createdAt: string;
}

export interface BuildTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface BuildState {
  sessionId?: string;
  status: "idle" | "working" | "waiting";
  activity?: string;
  todos: BuildTodo[];
  resumeAt?: string;
  stopRequested: boolean;
  baseCommit?: string;
  resetNeeded: boolean;
  shipTaskId?: string;
  reportedTaskId?: string;
  failedShips: number;
  updatedAt?: string;
}

interface StateRow {
  session_id: string | null;
  status: BuildState["status"];
  activity: string | null;
  todos_json: string | null;
  resume_at: string | null;
  stop_requested: number;
  base_commit: string | null;
  reset_needed: number;
  ship_task_id: string | null;
  reported_task_id: string | null;
  failed_ships: number;
  updated_at: string;
}

const COLUMNS: Record<keyof Omit<BuildState, "updatedAt">, string> = {
  sessionId: "session_id",
  status: "status",
  activity: "activity",
  todos: "todos_json",
  resumeAt: "resume_at",
  stopRequested: "stop_requested",
  baseCommit: "base_commit",
  resetNeeded: "reset_needed",
  shipTaskId: "ship_task_id",
  reportedTaskId: "reported_task_id",
  failedShips: "failed_ships",
};

/** What a patch may change; `null` clears an optional field. */
export type BuildStatePatch = { [K in keyof Omit<BuildState, "updatedAt">]?: BuildState[K] | null };

function toValue(key: keyof BuildStatePatch, value: unknown): string | number | null {
  if (value === null || value === undefined) return key === "todos" ? "[]" : key === "stopRequested" || key === "resetNeeded" || key === "failedShips" ? 0 : key === "status" ? "idle" : null;
  if (key === "todos") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

/**
 * The Construir conversation in `work.db`, shared by the server (which writes the owner's
 * messages and reads everything) and the agent runner (which answers and keeps the state).
 * `system` messages are notes for the agent, like a failed publication, never shown to the owner.
 */
export class BuildChatStore {
  constructor(private readonly db: Db) {}

  post(role: BuildRole, text: string, now: Date): number {
    return Number(this.db.prepare("INSERT INTO build_messages (role, text, handled, created_at) VALUES (?, ?, ?, ?)").run(role, text, role === "assistant" ? 1 : 0, now.toISOString()).lastInsertRowid);
  }

  /** Messages the agent has not read yet, oldest first. */
  pending(): BuildMessage[] {
    return (this.db.prepare("SELECT id, role, text, created_at FROM build_messages WHERE handled = 0 ORDER BY id").all() as { id: number; role: BuildRole; text: string; created_at: string }[]).map(
      (row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at }),
    );
  }

  markHandled(ids: number[]): void {
    const mark = this.db.prepare("UPDATE build_messages SET handled = 1 WHERE id = ?");
    for (const id of ids) mark.run(id);
  }

  /** The conversation the owner sees: their messages and the answers, the last `limit`. */
  messages(limit = 200): BuildMessage[] {
    const rows = this.db.prepare("SELECT id, role, text, created_at FROM build_messages WHERE role != 'system' ORDER BY id DESC LIMIT ?").all(limit) as {
      id: number;
      role: BuildRole;
      text: string;
      created_at: string;
    }[];
    return rows.reverse().map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at }));
  }

  state(): BuildState {
    const row = this.db.prepare("SELECT * FROM build_state WHERE id = 1").get() as StateRow | undefined;
    if (!row) return { status: "idle", todos: [], stopRequested: false, resetNeeded: false, failedShips: 0 };
    return {
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      status: row.status,
      ...(row.activity ? { activity: row.activity } : {}),
      todos: row.todos_json ? (JSON.parse(row.todos_json) as BuildTodo[]) : [],
      ...(row.resume_at ? { resumeAt: row.resume_at } : {}),
      stopRequested: row.stop_requested === 1,
      ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
      resetNeeded: row.reset_needed === 1,
      ...(row.ship_task_id ? { shipTaskId: row.ship_task_id } : {}),
      ...(row.reported_task_id ? { reportedTaskId: row.reported_task_id } : {}),
      failedShips: row.failed_ships,
      updatedAt: row.updated_at,
    };
  }

  update(patch: BuildStatePatch, now: Date): void {
    this.db.prepare("INSERT INTO build_state (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING").run(now.toISOString());
    const keys = Object.keys(patch) as (keyof BuildStatePatch)[];
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE build_state SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(", ")}, updated_at = ? WHERE id = 1`)
      .run(...keys.map((key) => toValue(key, patch[key])), now.toISOString());
  }
}
