import type { Db } from "../db/database.js";
import { formatLocal } from "../agenda/format.js";
import type { IntegrationStatusItem, IntegrationStatusSource } from "../tools/types.js";
import type { VapidConfig } from "./vapid.js";

const STALLED_AFTER_MS = 5 * 60_000;
const DEAD_LETTER_WINDOW_MS = 7 * 24 * 60 * 60_000;

function countOf(db: Db, sql: string, ...params: string[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** Web Push health: configured keys, subscribed devices and undeliverable notifications. */
export class PushStatusSource implements IntegrationStatusSource {
  constructor(
    private readonly db: Db,
    private readonly vapid: VapidConfig | undefined,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(): Promise<IntegrationStatusItem[]> {
    if (!this.vapid) return [{ provider: "push", status: "disabled", detail: "Las notificaciones no están configuradas (faltan las claves VAPID)." }];
    const devices = countOf(this.db, "SELECT count(*) AS n FROM push_subscriptions");
    const since = new Date(this.clock().getTime() - DEAD_LETTER_WINDOW_MS).toISOString();
    const dead = countOf(this.db, "SELECT count(*) AS n FROM outbox WHERE kind = 'push' AND status = 'dead' AND created_at >= ?", since);
    if (dead > 0) return [{ provider: "push", status: "error", detail: `${dead} notificaciones no se pudieron entregar en los últimos 7 días.` }];
    if (devices === 0) return [{ provider: "push", status: "needs_action", detail: "Ningún dispositivo tiene activadas las notificaciones." }];
    return [{ provider: "push", status: "connected", detail: `Notificaciones activas en ${devices} ${devices === 1 ? "dispositivo" : "dispositivos"}.` }];
  }
}

/**
 * Health of the internal agenda and its reminder worker. There is no worker heartbeat: a reminder that
 * is overdue, or an outbox entry nobody picked up, for more than five minutes means the worker is not running.
 */
export class AgendaStatusSource implements IntegrationStatusSource {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(): Promise<IntegrationStatusItem[]> {
    const now = this.clock();
    const stalledBefore = new Date(now.getTime() - STALLED_AFTER_MS).toISOString();
    const overdue = countOf(this.db, "SELECT count(*) AS n FROM reminders WHERE status = 'scheduled' AND due_utc < ?", stalledBefore);
    const stuck = countOf(
      this.db,
      "SELECT count(*) AS n FROM outbox WHERE (status = 'pending' AND next_attempt_utc < ?) OR (status = 'sending' AND locked_until_utc < ?)",
      stalledBefore,
      stalledBefore,
    );
    const account = "Agenda interna";
    if (overdue + stuck > 0) {
      return [{ provider: "calendar", account, status: "error", detail: "El proceso de recordatorios no está disparando avisos a tiempo; revisá que el worker esté corriendo." }];
    }
    const upcoming = this.db.prepare("SELECT count(*) AS n, min(due_utc) AS next FROM reminders WHERE status = 'scheduled'").get() as { n: number; next: string | null };
    const next = upcoming.next ? ` El próximo es el ${formatLocal(upcoming.next, this.timezone)}.` : "";
    return [{ provider: "calendar", account, status: "connected", detail: `${upcoming.n} ${upcoming.n === 1 ? "recordatorio programado" : "recordatorios programados"}.${next}` }];
  }
}
