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

/** Starts the detail of a stopped bridge whose owner-asked linking just ended (an expired code, no saved number): nothing fell, so nobody is warned. */
export const UNLINKED = "Sin vincular: ";

export interface ReconnectOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** After the quick attempts run out, one more try this often, 30 minutes by default. */
  slowRetryMs?: number;
  random: () => number;
}

export const DEFAULT_RECONNECT: ReconnectOptions = { baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: 8, random: Math.random };
const SLOW_RETRY_MS = 30 * 60_000;

export type CloseDecision =
  | { action: "reconnect"; delayMs: number; attempt: number }
  | { action: "stop"; status: WaSyncStatus; detail: string; clearSession: boolean };

/** Exponential backoff with jitter and a cap on quick attempts; past it, one slow attempt every half hour. */
export class ReconnectPolicy {
  private attempts = 0;

  constructor(private readonly options: ReconnectOptions = DEFAULT_RECONNECT) {}

  reset(): void {
    this.attempts = 0;
  }

  decide(statusCode: number | undefined, paired: boolean): CloseDecision {
    switch (statusCode) {
      case CloseCode.loggedOut:
        return { action: "stop", status: "logged_out", detail: "La sesión se cerró desde el teléfono. Abrí Configuración y tocá «Vincular».", clearSession: true };
      case CloseCode.badSession:
        return { action: "stop", status: "error", detail: "WhatsApp invalidó la sesión. Abrí Configuración y tocá «Vincular».", clearSession: true };
      case CloseCode.connectionReplaced:
        return { action: "stop", status: "error", detail: "Otra sesión reemplazó al puente. Verificá que haya una sola instancia y reintentá desde Configuración.", clearSession: false };
      case CloseCode.forbidden:
      case CloseCode.multideviceMismatch:
        return { action: "stop", status: "error", detail: `WhatsApp rechazó la conexión (${statusCode}); no se reintenta solo para no agravar una posible restricción. Podés reintentar desde Configuración.`, clearSession: false };
      default:
        break;
    }
    if (!paired && statusCode !== CloseCode.restartRequired) {
      return { action: "stop", status: "logged_out", detail: UNLINKED + "el código venció sin vincularse. Tocá «Vincular» en Configuración para pedir otro.", clearSession: false };
    }
    return this.nextAttempt(statusCode === CloseCode.restartRequired);
  }

  private nextAttempt(quick: boolean): CloseDecision {
    if (this.attempts >= this.options.maxAttempts) {
      this.attempts += 1;
      const slow = this.options.slowRetryMs ?? SLOW_RETRY_MS;
      return { action: "reconnect", delayMs: Math.round(slow * (0.9 + this.options.random() * 0.2)), attempt: this.attempts };
    }
    const ceiling = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** this.attempts);
    const delayMs = quick ? 1_000 + this.options.random() * 1_000 : ceiling / 2 + (this.options.random() * ceiling) / 2;
    this.attempts += 1;
    return { action: "reconnect", delayMs: Math.round(delayMs), attempt: this.attempts };
  }
}
