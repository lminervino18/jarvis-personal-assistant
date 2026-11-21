import type { Task } from "../tasks/task-store.js";
import type { TaskOutcome } from "../tasks/task-service.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";

const SOURCE = { provider: "tasks" };
const DISABLED = "Las tareas delegadas no están configuradas en este servidor.";
const NOT_DONE_NOTE = "Nunca digas que una tarea está hecha si su estado no es ready o accepted.";

function overview(task: Task) {
  return {
    ref: task.ref,
    title: task.title,
    status: task.status,
    phase: task.phase,
    paused: task.paused,
    iteration: task.iteration,
    updatedAt: task.updatedAt,
    waitingFor: task.blocker?.kind ?? null,
  };
}

function respond(ctx: ToolContext, outcome: TaskOutcome) {
  const tasks = ctx.services.tasks;
  if (!outcome.ok) return fail(outcome.code, outcome.message);
  if (tasks) ctx.emitCard(tasks.card(outcome.task));
  return ok(SOURCE, [{ ...overview(outcome.task), result: outcome.message }], { note: NOT_DONE_NOTE });
}

export const taskCreate = defineTool({
  name: "task_create",
  description:
    "Registra una tarea de trabajo para que la hagan agentes en segundo plano (planificador, ejecutor y revisor independiente). Usala cuando el dueño pide algo que requiere ejecutar trabajo (programar, investigar a fondo, preparar un entregable), no para consultas rápidas. 'request' lleva el pedido completo con todo lo que el dueño dijo, sin resumirlo. 'project' es un slug de task_projects si corresponde. No incluyas datos personales del dueño que no sean necesarios para la tarea.",
  describe(_ctx, input) {
    return {
      title: "Crear tarea delegada",
      summary: input.title,
      details: [
        { label: "Proyecto", value: input.project ?? "sin proyecto" },
        { label: "Pedido", value: input.request.slice(0, 300) },
      ],
    };
  },
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    return respond(ctx, tasks.create(input, ctx.now()));
  },
});

export const taskProjects = defineTool({
  name: "task_projects",
  description: "Lista los proyectos de trabajo configurados (slug y descripción) para asociarlos a una tarea.",
  async execute(ctx) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    return ok(SOURCE, tasks.projects());
  },
});

export const taskList = defineTool({
  name: "task_list",
  description: "Lista tareas delegadas con su estado. Por defecto, las activas.",
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    return ok(SOURCE, tasks.list(input.filter ?? "active", input.limit ?? 10).map(overview), { note: NOT_DONE_NOTE });
  },
});

export const taskStatus = defineTool({
  name: "task_status",
  description: "Estado detallado de una tarea por su número: fase, iteración, qué espera del dueño, costo y últimos eventos. Muestra la tarjeta en el chat.",
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    const task = tasks.byRef(input.ref);
    if (!task) return fail("not_found", `No existe la tarea #${input.ref}.`);
    ctx.emitCard(tasks.card(task));
    return ok(
      SOURCE,
      [
        {
          ...overview(task),
          goal: task.spec?.goal ?? null,
          blocker: task.blocker ?? null,
          costUsd: Math.round(task.costUsd * 100) / 100,
          budgetUsd: task.budgetUsd,
          recentEvents: tasks.events(task).map((event) => ({ at: event.createdAt, what: event.message })),
        },
      ],
      { note: NOT_DONE_NOTE },
    );
  },
});

export const taskResult = defineTool({
  name: "task_result",
  description:
    "Resultado de una tarea: resumen del ejecutor, cambios, entregables, veredicto del revisor criterio por criterio con su evidencia y archivos modificados. Usala para 'mostrame el resultado'.",
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    const task = tasks.byRef(input.ref);
    if (!task) return fail("not_found", `No existe la tarea #${input.ref}.`);
    ctx.emitCard(tasks.card(task));
    const criteria = (task.spec?.acceptanceCriteria ?? []).map((criterion) => {
      const verdict = task.review?.criteria.find((item) => item.id === criterion.id);
      return { id: criterion.id, text: criterion.text, review: verdict?.status ?? "sin revisar", evidence: verdict?.evidence ?? null };
    });
    return ok(
      SOURCE,
      [
        {
          ...overview(task),
          goal: task.spec?.goal ?? null,
          summary: task.report?.summary ?? null,
          changes: task.report?.changes ?? [],
          deliverables: task.report?.deliverables ?? [],
          reviewVerdict: task.review?.verdict ?? null,
          reviewSummary: task.review?.summary ?? null,
          criteria,
          checksRunByReviewer: task.review?.checksRun ?? [],
          changedFiles: task.evidence?.changedFiles ?? [],
          diffStat: task.evidence?.diffStat ?? null,
        },
      ],
      { note: `${NOT_DONE_NOTE} El diff completo y los archivos se ven desde la tarjeta.` },
    );
  },
});

export const taskFeedback = defineTool({
  name: "task_feedback",
  description:
    "Manda al agente un pedido de cambios, una corrección o la respuesta a una pregunta de la tarea. Si la tarea estaba lista o frenada, vuelve a trabajar; si está en curso, se suma a la próxima iteración. Pasá el pedido del dueño tal cual.",
  describe(_ctx, input) {
    return { title: `Cambios para la tarea #${input.ref}`, summary: input.message.slice(0, 200), details: [] };
  },
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    return respond(ctx, tasks.feedback(input.ref, input.message, ctx.now()));
  },
});

export const taskControl = defineTool({
  name: "task_control",
  description:
    "Pausa, reanuda, cancela o reintenta una tarea. 'addBudgetUsd' suma presupuesto (máximo USD 20 por vez) y solo se usa si el dueño lo pidió explícitamente.",
  describe(_ctx, input) {
    const labels = { pause: "Pausar", resume: "Reanudar", cancel: "Cancelar", retry: "Reintentar" };
    return {
      title: `${labels[input.action]} la tarea #${input.ref}`,
      summary: input.addBudgetUsd ? `Suma USD ${input.addBudgetUsd} de presupuesto` : "Sin cambio de presupuesto",
      details: [],
    };
  },
  async execute(ctx, input) {
    const tasks = ctx.services.tasks;
    if (!tasks) return fail("disabled", DISABLED);
    return respond(ctx, tasks.control(input.ref, input.action, input.addBudgetUsd, ctx.now()));
  },
});

export const taskTools = [taskCreate, taskProjects, taskList, taskStatus, taskResult, taskFeedback, taskControl];
