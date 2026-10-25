import type { WaSyncStatus } from "./message-store.js";

/** WhatsApp Web close codes the bridge reacts to (same values as Baileys' DisconnectReason). */
export const CloseCode = {
  loggedOut: 401,
  forbidden: 403,
  connectionReplaced: 440,
  multideviceMismatch: 411,
  badSession: 500,
  restartRequired: 515,
} as const;

export interface ReconnectOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  random: () => number;
}

export const DEFAULT_RECONNECT: ReconnectOptions = { baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: 8, random: Math.random };

export type CloseDecision =
  | { action: "reconnect"; delayMs: number; attempt: number }
  | { action: "stop"; status: WaSyncStatus; detail: string; clearSession: boolean };

/** Exponential backoff with jitter and a hard cap on consecutive attempts. */
export class ReconnectPolicy {
  private attempts = 0;

  constructor(private readonly options: ReconnectOptions = DEFAULT_RECONNECT) {}

  reset(): void {
    this.attempts = 0;
  }

  decide(statusCode: number | undefined, paired: boolean): CloseDecision {
    switch (statusCode) {
      case CloseCode.loggedOut:
        return { action: "stop", status: "logged_out", detail: "La sesión se cerró desde el teléfono. Reiniciá el puente para vincular de nuevo.", clearSession: true };
      case CloseCode.badSession:
        return { action: "stop", status: "error", detail: "WhatsApp invalidó la sesión. Reiniciá el puente para vincular de nuevo.", clearSession: true };
      case CloseCode.connectionReplaced:
        return { action: "stop", status: "error", detail: "Otra sesión reemplazó al puente. Verificá que haya una sola instancia y reiniciá.", clearSession: false };
      case CloseCode.forbidden:
      case CloseCode.multideviceMismatch:
        return { action: "stop", status: "error", detail: `WhatsApp rechazó la conexión (${statusCode}); no se reintenta para no agravar una posible restricción.`, clearSession: false };
      default:
        break;
    }
    if (!paired && statusCode !== CloseCode.restartRequired) {
      return { action: "stop", status: "disconnected", detail: "El código QR venció sin vincularse. Reiniciá el puente para generar otro.", clearSession: false };
    }
    return this.nextAttempt(statusCode === CloseCode.restartRequired);
  }

  private nextAttempt(quick: boolean): CloseDecision {
    if (this.attempts >= this.options.maxAttempts) {
      return {
        action: "stop",
        status: "error",
        detail: `Se agotaron los ${this.options.maxAttempts} reintentos de conexión. Revisá la red y reiniciá el puente.`,
        clearSession: false,
      };
    }
    const ceiling = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** this.attempts);
    const delayMs = quick ? 1_000 + this.options.random() * 1_000 : ceiling / 2 + (this.options.random() * ceiling) / 2;
    this.attempts += 1;
    return { action: "reconnect", delayMs: Math.round(delayMs), attempt: this.attempts };
  }
}
