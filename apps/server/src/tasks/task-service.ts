import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { finalTaskStatuses, type Card, type TaskCardAction, type TaskPhase } from "@jarvis/contracts";
import { BUILD_PROJECT, isCommitTitle, MAX_PATCH_BYTES, type PublicationSpool } from "../publisher/spool.js";
import type { Attachment, Publication, Task, TaskPatch, TaskStore } from "./task-store.js";
import type { ProjectInfo, WorkLayout } from "./workspace.js";
import { safeFileName } from "./workspace.js";

export type TaskCard = Extract<Card, { kind: "task" }>;

export interface TaskServiceOptions {
  defaultBudgetUsd: number;
  maxAttachmentBytes: number;
}

export type TaskOutcome = { ok: true; task: Task; message: string } | { ok: false; code: "not_found" | "invalid_input"; message: string };

const RUNNER_STALE_MS = 2 * 60_000;
const PUBLISH_STALE_MS = 2 * 60 * 60_000;
const BUILD_TITLE_CHARS = 80;
const BUILD_LIST_LIMIT = 20;

function buildTitle(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim()) ?? text;
  const title = line.trim().replace(/\s+/g, " ");
  return title.length > BUILD_TITLE_CHARS ? `${title.slice(0, BUILD_TITLE_CHARS - 1).trimEnd()}…` : title;
}

const OPEN_FOR_FEEDBACK = new Set(["awaiting_owner", "ready", "accepted", "failed"]);
const RESUMABLE_BLOCKERS = new Set(["budget", "usage_limit", "error", "review_limit"]);

/** The chat card for a task, built only from stored state. */
export function taskCard(task: Task, publication?: Publication): TaskCard {
  const review = task.review
    ? { verdict: task.review.verdict, passed: task.review.criteria.filter((c) => c.status === "pass").length, total: task.review.criteria.length }
    : undefined;
  return {
    kind: "task",
    taskId: task.id,
    ref: task.ref,
    title: task.title,
    status: task.status,
    phase: task.phase,
    paused: task.paused,
    iteration: task.iteration,
    ...(task.status === "ready" || task.status === "accepted" ? { summary: task.report?.summary.slice(0, 600) } : {}),
    ...(task.blocker ? { blocker: task.blocker } : {}),
    ...(review ? { review } : {}),
    ...(task.report?.deliverables.length ? { deliverables: task.report.deliverables.slice(0, 20) } : {}),
    costUsd: Math.round(task.costUsd * 100) / 100,
    budgetUsd: task.budgetUsd,
    ...(task.project === BUILD_PROJECT ? { build: true } : {}),
    ...(publication
      ? {
          publication: {
            status: publication.status,
            ...(publication.step ? { step: publication.step } : {}),
            ...(publication.commitSha ? { commit: publication.commitSha } : {}),
            ...(publication.message ? { message: publication.message } : {}),
          },
        }
      : {}),
    updatedAt: task.updatedAt,
  };
}

/**
 * Owner-side operations on delegated tasks: creation, feedback, control and card
 * decisions. Used by the chat tools and by card taps; it never runs an agent itself.
 */
export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly layout: WorkLayout,
    private readonly options: TaskServiceOptions,
    private readonly spool?: PublicationSpool,
  ) {}

  /** Whether the agent runner wrote a heartbeat recently, so queued tasks will actually progress. */
  runnerAlive(now: Date): boolean {
    const at = this.store.lastBeat();
    return at !== undefined && now.getTime() - Date.parse(at) < RUNNER_STALE_MS;
  }

  /** Until when the runner paused agents to keep plan headroom for the chat, if it did. */
  agentsHeldUntil(now: Date): Date | undefined {
    return this.store.agentsHeldUntil(now);
  }

  projects(): ProjectInfo[] {
    return this.layout.projects();
  }

  byRef(ref: number): Task | undefined {
    return this.store.getByRef(ref);
  }

  list(filter: "active" | "finished" | "all", limit: number): Task[] {
    return this.store.list(filter, limit);
  }

  events(task: Task, limit = 5) {
    return this.store.events(task.id, limit);
  }

  attachments(task: Task): Attachment[] {
    return this.store.attachments(task.id);
  }

  create(input: { title: string; request: string; project?: string; attachmentIds?: string[] }, now: Date): TaskOutcome {
    if (input.project && !this.layout.hasProject(input.project)) {
      return { ok: false, code: "not_found", message: `No existe el proyecto "${input.project}". Usá task_projects para ver los disponibles.` };
    }
    const ids = input.attachmentIds ?? [];
    const unbound = this.store.unboundAttachments(ids);
    if (unbound.length !== ids.length) return { ok: false, code: "invalid_input", message: "Algún adjunto no existe o ya pertenece a otra tarea." };
    const task = this.store.create({ ...input, budgetUsd: this.options.defaultBudgetUsd }, now);
    const held = this.agentsHeldUntil(now);
    const note = !this.runnerAlive(now)
      ? " El ejecutor de agentes no está activo: va a empezar cuando arranque."
      : held
        ? ` Los agentes están en pausa para cuidar el uso del plan hasta ${held.toISOString()}.`
        : "";
    return { ok: true, task, message: `Tarea #${task.ref} en cola.${note}` };
  }

  saveAttachment(input: { name: string; mediaType: string; data: Buffer }, now: Date): Attachment | undefined {
    if (input.data.length === 0 || input.data.length > this.options.maxAttachmentBytes) return undefined;
    const attachment = {
      id: randomUUID(),
      name: safeFileName(input.name),
      mediaType: input.mediaType.slice(0, 100),
      size: input.data.length,
      sha256: createHash("sha256").update(input.data).digest("hex"),
    };
    const path = this.layout.inboxPath(attachment.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.data, { mode: 0o600 });
    this.store.addAttachment(attachment, now);
    return attachment;
  }

  feedback(ref: number, message: string, now: Date): TaskOutcome {
    const task = this.store.getByRef(ref);
    if (!task) return this.notFound(ref);
    if (task.status === "cancelled") return { ok: false, code: "invalid_input", message: `La tarea #${ref} está cancelada.` };
    const pendingFeedback = [...task.pendingFeedback, message];
    if (task.status === "queued" || task.status === "running") {
      this.store.update(task.id, { pendingFeedback }, now);
      this.store.addEvent(task.id, "feedback", "Pedido del dueño agendado para la próxima iteración.", false, now);
      return this.done(task.id, "Lo sumo a la próxima iteración.");
    }
    if (!OPEN_FOR_FEEDBACK.has(task.status)) return { ok: false, code: "invalid_input", message: "La tarea no acepta cambios ahora." };
    const phase: TaskPhase = task.phase === "plan" || !task.spec ? "plan" : "execute";
    const patch: TaskPatch = { pendingFeedback, status: "queued", phase, fixRounds: 0, attempts: 0, blocker: null, notBefore: null, finishedAt: null };
    if (!this.store.update(task.id, patch, now, [task.status])) return this.changed(ref);
    this.store.addEvent(task.id, "feedback", "El dueño pidió cambios; vuelve a la cola.", false, now);
    return this.done(task.id, `La tarea #${ref} vuelve a trabajar con tu pedido.`);
  }

  control(ref: number, action: "pause" | "resume" | "cancel" | "retry", addBudgetUsd: number | undefined, now: Date): TaskOutcome {
    const task = this.store.getByRef(ref);
    if (!task) return this.notFound(ref);
    return this.apply(task, action, now, addBudgetUsd);
  }

  /** A tap on a task card. Approvals are recorded here, by the owner, never by the model. */
  decide(taskId: string, action: TaskCardAction, approvalId: string | undefined, now: Date): TaskOutcome {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, code: "not_found", message: "La tarea no existe." };
    if (action === "accept") {
      if (!this.store.update(task.id, { status: "accepted", blocker: null, finishedAt: now.toISOString() }, now, ["ready"])) {
        return { ok: false, code: "invalid_input", message: "Solo se acepta una entrega lista para revisar." };
      }
      this.store.addEvent(task.id, "accepted", "El dueño aceptó la entrega.", false, now);
      return this.done(task.id, `Aceptaste la tarea #${task.ref}.`);
    }
    if (action === "approve" || action === "reject") return this.decideApproval(task, action, approvalId, now);
    if (action === "publish") return this.publish(task.id, now);
    return this.apply(task, action, now);
  }

  /** The current card of a task, for refreshing cards stored in the chat history. */
  cardFor(taskId: string): TaskCard | undefined {
    const task = this.store.get(taskId);
    return task ? this.card(task) : undefined;
  }

  card(task: Task): TaskCard {
    return taskCard(task, this.store.publication(task.id));
  }

  /** A change to JARVIS itself, asked from build mode: a task on the jarvis project, without the model. */
  createBuild(text: string, now: Date): TaskOutcome {
    if (!this.layout.hasProject(BUILD_PROJECT)) return this.invalid("El modo construir todavía no está instalado en el servidor.");
    const task = this.store.create({ title: buildTitle(text), request: text, project: BUILD_PROJECT, source: "build", budgetUsd: this.options.defaultBudgetUsd }, now);
    return this.done(task.id, `Tarea #${task.ref} en cola.`);
  }

  /** An answer or change request from build mode. A task already published starts a new one instead of reopening. */
  buildFeedback(taskId: string, text: string, now: Date): TaskOutcome {
    const task = this.store.get(taskId);
    if (!task || task.project !== BUILD_PROJECT) return { ok: false, code: "not_found", message: "La tarea no existe." };
    if (task.status === "accepted" || task.status === "cancelled") return this.createBuild(text, now);
    return this.feedback(task.ref, text, now);
  }

  buildCards(): TaskCard[] {
    return this.store.listByProject(BUILD_PROJECT, BUILD_LIST_LIMIT).map((task) => this.card(task));
  }

  /**
   * The owner's tap on Publish: queues a signed request with the reviewed change for the host
   * publisher, which checks, pushes and deploys it. Only one publication runs at a time.
   */
  publish(taskId: string, now: Date): TaskOutcome {
    const task = this.store.get(taskId);
    if (!task) return { ok: false, code: "not_found", message: "La tarea no existe." };
    if (task.project !== BUILD_PROJECT) return this.invalid("Solo se publican cambios de JARVIS.");
    const retry = task.status === "accepted" && this.store.publication(task.id)?.status === "failed";
    if ((task.status !== "ready" && !retry) || !task.evidence) return this.invalid("Se publica una entrega lista y revisada.");
    if (!this.spool?.available()) return this.invalid("La publicación no está configurada en el servidor.");
    const patch = this.layout.patch(task.id, task.evidence, MAX_PATCH_BYTES);
    if (!patch?.trim()) return this.invalid("No encontré el cambio para publicar, o es demasiado grande.");
    const proposed = task.report?.commitTitle?.trim();
    const commitTitle = proposed && isCommitTitle(proposed) ? proposed : `feat(build): apply build task ${task.ref}`;
    const publication = this.store.createPublication(task.id, commitTitle, now);
    if (!publication) return this.invalid("Ya hay una publicación en curso; esperá a que termine.");
    if (!this.store.update(task.id, { status: "accepted", blocker: null, finishedAt: now.toISOString() }, now, ["ready", "accepted"])) {
      this.store.updatePublication(publication.id, { status: "failed", step: "request", message: "La tarea cambió de estado antes de publicar." }, now);
      return this.changed(task.ref);
    }
    try {
      this.spool.submit({ id: publication.id, taskRef: task.ref, commitTitle, requestedAt: publication.requestedAt }, patch);
    } catch {
      this.store.updatePublication(publication.id, { status: "failed", step: "request", message: "No pude dejarle el pedido al publicador." }, now);
      return this.invalid("No pude dejarle el pedido al publicador.");
    }
    this.store.addEvent(task.id, "publish_requested", "El dueño pidió publicar el cambio.", false, now);
    return this.done(task.id, `Publicando la tarea #${task.ref}: chequeo completo, GitHub y despliegue.`);
  }

  /** Reads the publisher's results and tells the owner when a publication ends. */
  syncPublications(now: Date): void {
    if (!this.spool) return;
    for (const publication of this.store.activePublications()) {
      const result = this.spool.result(publication.id);
      const task = this.store.get(publication.taskId);
      if (!result) {
        if (now.getTime() - Date.parse(publication.requestedAt) > PUBLISH_STALE_MS) {
          this.finishPublication(publication, task, { status: "failed", step: "publisher", message: "El publicador no respondió en dos horas." }, now);
        }
        continue;
      }
      if (result.status === "running") {
        if (publication.status !== "running" || publication.step !== result.step) this.store.updatePublication(publication.id, { status: "running", step: result.step }, now);
        continue;
      }
      this.finishPublication(publication, task, { status: result.status, step: result.step, commitSha: result.commit, message: result.message }, now);
    }
  }

  private finishPublication(
    publication: Publication,
    task: Task | undefined,
    patch: { status: "published" | "failed"; step?: string; commitSha?: string; message?: string },
    now: Date,
  ): void {
    if (!this.store.updatePublication(publication.id, patch, now) || !task) return;
    const message =
      patch.status === "published"
        ? `La tarea #${task.ref} está publicada en producción${patch.commitSha ? ` (commit ${patch.commitSha})` : ""}.`
        : `No se pudo publicar la tarea #${task.ref}${patch.message ? `: ${patch.message}` : "."}`;
    this.store.addEvent(task.id, patch.status === "published" ? "published" : "publish_failed", message, true, now);
    this.store.update(task.id, {}, now);
  }

  private apply(task: Task, action: "pause" | "resume" | "cancel" | "retry", now: Date, addBudgetUsd?: number): TaskOutcome {
    const budget = addBudgetUsd ? { budgetUsd: task.budgetUsd + addBudgetUsd } : {};
    switch (action) {
      case "pause":
        if (!this.store.update(task.id, { paused: true }, now, ["queued", "running"])) return this.invalid("Solo se pausa una tarea en cola o en curso.");
        this.store.addEvent(task.id, "paused", "El dueño pausó la tarea.", false, now);
        return this.done(task.id, `Pausé la tarea #${task.ref}.`);
      case "cancel":
        if (finalTaskStatuses.has(task.status)) return this.invalid("La tarea ya terminó.");
        if (!this.store.update(task.id, { status: "cancelled", blocker: null, finishedAt: now.toISOString() }, now, [task.status])) return this.changed(task.ref);
        this.store.addEvent(task.id, "cancelled", "El dueño canceló la tarea.", false, now);
        return this.done(task.id, `Cancelé la tarea #${task.ref}.`);
      case "resume":
        if (task.paused) {
          this.store.update(task.id, { paused: false, ...budget }, now);
          this.store.addEvent(task.id, "resumed", "El dueño reanudó la tarea.", false, now);
          return this.done(task.id, `Reanudé la tarea #${task.ref}.`);
        }
        if (task.status !== "awaiting_owner" || !task.blocker || !RESUMABLE_BLOCKERS.has(task.blocker.kind)) {
          return this.invalid("No hay nada que reanudar: si espera una respuesta, mandá el pedido o la aprobación.");
        }
        return this.requeue(task, now, budget, task.blocker.kind === "review_limit");
      case "retry":
        if (task.status !== "failed" && task.status !== "awaiting_owner") return this.invalid("Solo se reintenta una tarea fallida o frenada.");
        return this.requeue(task, now, budget, true);
    }
  }

  private requeue(task: Task, now: Date, budget: TaskPatch, resetFixRounds: boolean): TaskOutcome {
    const budgetUsd = budget.budgetUsd ?? task.budgetUsd;
    if (budgetUsd - task.costUsd < 0.05) return this.invalid(`La tarea gastó USD ${task.costUsd.toFixed(2)} de ${task.budgetUsd.toFixed(2)}: hace falta sumar presupuesto.`);
    const patch: TaskPatch = {
      ...budget,
      status: "queued",
      phase: task.phase ?? (task.spec ? "execute" : "plan"),
      attempts: 0,
      notBefore: null,
      blocker: null,
      finishedAt: null,
      ...(resetFixRounds ? { fixRounds: 0 } : {}),
    };
    if (!this.store.update(task.id, patch, now, [task.status])) return this.changed(task.ref);
    this.store.addEvent(task.id, "resumed", "El dueño la volvió a poner en marcha.", false, now);
    return this.done(task.id, `La tarea #${task.ref} vuelve a la cola.`);
  }

  private decideApproval(task: Task, action: "approve" | "reject", approvalId: string | undefined, now: Date): TaskOutcome {
    if (!approvalId || task.blocker?.kind !== "approval" || task.blocker.approvalId !== approvalId) return this.invalid("No hay una aprobación pendiente con ese identificador.");
    const description = this.store.decideApproval(approvalId, task.id, action === "approve" ? "approved" : "rejected", now);
    if (!description) return this.invalid("Esa aprobación ya se decidió.");
    const note =
      action === "approve"
        ? `El dueño aprobó: ${description}. Ningún agente tiene credenciales para ejecutarlo: prepará todo lo necesario y dejá instrucciones exactas para que lo haga el dueño.`
        : `El dueño rechazó: ${description}. No lo hagas; terminá el trabajo sin esa acción.`;
    const patch: TaskPatch = { pendingFeedback: [...task.pendingFeedback, note], status: "queued", phase: "execute", blocker: null, attempts: 0, notBefore: null };
    if (!this.store.update(task.id, patch, now, ["awaiting_owner"])) return this.changed(task.ref);
    this.store.addEvent(task.id, action === "approve" ? "approved" : "rejected", action === "approve" ? "El dueño aprobó la acción." : "El dueño rechazó la acción.", false, now);
    return this.done(task.id, action === "approve" ? "Aprobación registrada." : "Rechazo registrado.");
  }

  private done(taskId: string, message: string): TaskOutcome {
    return { ok: true, task: this.store.require(taskId), message };
  }

  private invalid(message: string): TaskOutcome {
    return { ok: false, code: "invalid_input", message };
  }

  private changed(ref: number): TaskOutcome {
    return this.invalid(`La tarea #${ref} cambió de estado mientras tanto; consultá su estado y probá de nuevo.`);
  }

  private notFound(ref: number): TaskOutcome {
    return { ok: false, code: "not_found", message: `No existe la tarea #${ref}.` };
  }
}
