import type { ExecutionView, TurnActivityView } from "./activity-store.js";
import { failureLabel, integrations, preparingLabel, presentTool, waitingLabel, type IntegrationId, type PresentedTool, type Visual } from "./registry.js";

/** `working` and `offline` are live; the rest are how the work ended. */
export type ActivityTone = "working" | "done" | "problem" | "cancelled" | "approval" | "offline";

export interface ItemView {
  id: string;
  label: string;
  tone: ActivityTone;
  visual: Visual;
}

export interface ActivityView {
  tone: ActivityTone;
  title: string;
  /** One visual per distinct integration involved, at most three. */
  visuals: Visual[];
  items: ItemView[];
}

const MAX_VISUALS = 3;

function itemOf(execution: ExecutionView): ItemView {
  const tool = presentTool(execution.tool);
  const visual = integrations[tool.integration].visual;
  switch (execution.phase) {
    case "preparing":
      return { id: execution.id, label: preparingLabel(tool), tone: "working", visual };
    case "running":
      return { id: execution.id, label: tool.running, tone: "working", visual };
    case "waiting":
      return { id: execution.id, label: waitingLabel(tool), tone: "working", visual };
    case "needs_approval":
      return { id: execution.id, label: "Confirmación solicitada", tone: "approval", visual };
    case "succeeded":
      return { id: execution.id, label: tool.done, tone: "done", visual };
    case "failed":
      return { id: execution.id, label: failureLabel(tool, execution.errorCode), tone: "problem", visual };
    case "cancelled":
      return { id: execution.id, label: "Cancelado", tone: "cancelled", visual };
    case "interrupted":
      return { id: execution.id, label: "Sin conexión", tone: "offline", visual };
  }
}

function distinct(tools: PresentedTool[]): IntegrationId[] {
  return [...new Set(tools.map((tool) => tool.integration))];
}

function visualsOf(tools: PresentedTool[]): Visual[] {
  return distinct(tools)
    .slice(0, MAX_VISUALS)
    .map((id) => integrations[id].visual);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function finished(items: ItemView[], executions: readonly ExecutionView[]): { tone: ActivityTone; title: string } {
  const failed = items.filter((item) => item.tone === "problem");
  if (failed.length > 0) {
    return { tone: "problem", title: items.length === 1 ? (failed[0] as ItemView).label : `${plural(failed.length, "acción falló", "acciones fallaron")} de ${items.length}` };
  }
  if (items.every((item) => item.tone === "cancelled")) return { tone: "cancelled", title: "Cancelado" };
  if (items.some((item) => item.tone === "approval")) return { tone: "approval", title: "Confirmación solicitada" };
  if (items.length === 1) return { tone: "done", title: (items[0] as ItemView).label };
  const succeeded = executions.filter((execution) => execution.phase === "succeeded").length;
  return { tone: "done", title: plural(succeeded, "acción realizada", "acciones realizadas") };
}

function working(items: ItemView[]): { tone: ActivityTone; title: string } {
  const active = items.filter((item) => item.tone === "working");
  return { tone: "working", title: active.length === 1 ? (active[0] as ItemView).label : `Trabajando en ${active.length} cosas…` };
}

/**
 * What to show for a turn, or null when there is nothing to show: no tools and the reply already started.
 * Several calls running together get one summary line instead of a line that keeps changing.
 */
export function describeActivity(turn: TurnActivityView): ActivityView | null {
  const executions = turn.executions;
  const items = executions.map(itemOf);
  const tools = executions.map((execution) => presentTool(execution.tool));
  const visuals = visualsOf(tools);
  const open = items.some((item) => item.tone === "working");
  if (open) return { ...working(items), visuals, items };
  if (executions.length === 0) {
    return turn.stage === "thinking" ? { tone: "working", title: "Pensando…", visuals: [], items: [] } : null;
  }
  if (items.some((item) => item.tone === "offline")) return { tone: "offline", title: "Sin conexión", visuals, items };
  if (turn.stage === "thinking") return { tone: "working", title: "Procesando el resultado…", visuals, items };
  return { ...finished(items, executions), visuals, items };
}
