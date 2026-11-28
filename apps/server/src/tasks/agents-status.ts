import type { IntegrationStatusItem, IntegrationStatusSource } from "../tools/types.js";
import type { TaskService } from "./task-service.js";

/** Reports whether the agent runner is alive and how many tasks wait. */
export class AgentsStatusSource implements IntegrationStatusSource {
  constructor(
    private readonly tasks: TaskService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(): Promise<IntegrationStatusItem[]> {
    const active = this.tasks.list("active", 50);
    const waiting = active.filter((task) => task.status === "awaiting_owner" || task.status === "ready").length;
    const counts = `${active.length} activas, ${waiting} esperando al dueño`;
    const now = this.now();
    if (!this.tasks.runnerAlive(now)) {
      return [{ provider: "agents", status: "disconnected", detail: `El ejecutor de agentes no está corriendo; las tareas quedan en cola (${counts}).` }];
    }
    return [{ provider: "agents", status: "connected", detail: `Ejecutor de agentes activo; ${counts}.` }];
  }
}
