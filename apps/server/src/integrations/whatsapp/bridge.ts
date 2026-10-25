import type { AuthenticationState, BaileysEventMap } from "baileys";
import type { Logger } from "pino";
import { WhatsAppEventHandlers } from "./event-handlers.js";
import type { WaSyncStatus, WhatsAppStore } from "./message-store.js";
import type { DbAuthState } from "./auth-state.js";
import type { PairingStore } from "./pairing-store.js";
import type { CloseDecision, ReconnectPolicy } from "./reconnect-policy.js";

const HEARTBEAT_MS = 60_000;
const STABLE_MS = 120_000;
const QR_VALID_MS = 60_000;

/** The slice of a Baileys socket the bridge uses. It deliberately has no way to send anything. */
export interface BridgeSocket {
  ev: { on<E extends keyof BaileysEventMap>(event: E, listener: (data: BaileysEventMap[E]) => void): void };
  end(error: Error | undefined): void;
}

export interface BridgeOptions {
  store: WhatsAppStore;
  auth: Pick<DbAuthState, "state" | "saveCreds" | "clear">;
  pairing: Pick<PairingStore, "publish" | "clear">;
  connect(auth: AuthenticationState): BridgeSocket;
  policy: ReconnectPolicy;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => Date;
}

export type BridgePhase = "idle" | "connecting" | "open" | "waiting" | "stopped";

const statusCodeOf = (error: unknown): number | undefined => (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * Read-only WhatsApp session. It reacts to events and records them; it never sends messages,
 * receipts or presence, reconnects with capped backoff, and stops when the session is signed out or invalid.
 */
export class WhatsAppBridge {
  phase: BridgePhase = "idle";
  private socket?: BridgeSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private readonly handlers: WhatsAppEventHandlers;
  private readonly now: () => Date;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.handlers = new WhatsAppEventHandlers(options.store, this.now);
  }

  start(): void {
    if (this.phase === "idle") this.open();
  }

  stop(): void {
    this.clearTimers();
    this.options.pairing.clear();
    const socket = this.socket;
    this.socket = undefined;
    socket?.end(undefined);
    if (this.phase !== "stopped") this.options.store.setStatus("baileys", "disconnected", this.now(), "Puente detenido.");
    this.phase = "stopped";
  }

  private open(): void {
    this.phase = "connecting";
    const socket = this.options.connect(this.options.auth.state);
    this.socket = socket;
    this.listen(socket);
  }

  private listen(socket: BridgeSocket): void {
    const on = <E extends keyof BaileysEventMap>(event: E, handler: (data: BaileysEventMap[E]) => void) =>
      socket.ev.on(event, (data) => {
        if (this.socket !== socket) return;
        try {
          handler(data);
        } catch (error) {
          this.options.log.error({ event, error: errorName(error) }, "whatsapp event handler failed");
        }
      });

    on("creds.update", () => void this.persistCreds());
    on("connection.update", (update) => {
      if (update.qr) this.publishQr(update.qr);
      if (update.connection === "open") this.handleOpen();
      if (update.connection === "close") this.handleClose(socket, update.lastDisconnect?.error);
    });
    on("messages.upsert", ({ messages }) => void this.handlers.messagesUpsert(messages));
    on("messages.update", (updates) => this.handlers.messagesUpdate(updates));
    on("messages.delete", (event) => this.handlers.messagesDelete(event));
    on("messaging-history.set", (event) => {
      this.handlers.historySet(event);
      this.options.store.refreshSyncState("baileys", this.currentStatus(), this.now());
    });
    on("chats.upsert", (chats) => this.handlers.chatNames(chats));
    on("contacts.upsert", (contacts) => this.handlers.contactNames(contacts));
    on("groups.upsert", (groups) => this.handlers.groupSubjects(groups));
    on("groups.update", (groups) => this.handlers.groupSubjects(groups));
  }

  private async persistCreds(): Promise<void> {
    try {
      await this.options.auth.saveCreds();
    } catch (error) {
      this.options.log.error({ error: errorName(error) }, "whatsapp credentials could not be saved");
    }
  }

  private currentStatus(): WaSyncStatus {
    return this.phase === "open" ? "connected" : "disconnected";
  }

  private publishQr(qr: string): void {
    const now = this.now();
    this.options.pairing.publish(qr, new Date(now.getTime() + QR_VALID_MS), now);
    this.options.store.setStatus("baileys", "pairing", now, "Esperando que escanees el código QR.");
  }

  private handleOpen(): void {
    this.phase = "open";
    this.options.pairing.clear();
    this.options.store.refreshSyncState("baileys", "connected", this.now());
    this.heartbeat = setInterval(() => this.options.store.setStatus("baileys", "connected", this.now()), HEARTBEAT_MS);
    this.stableTimer = setTimeout(() => this.options.policy.reset(), STABLE_MS);
    this.options.log.info("whatsapp connection open");
  }

  private handleClose(socket: BridgeSocket, error: unknown): void {
    this.clearTimers();
    this.options.pairing.clear();
    this.socket = undefined;
    socket.end(undefined);
    const decision = this.options.policy.decide(statusCodeOf(error), Boolean(this.options.auth.state.creds.me));
    if (decision.action === "stop") this.halt(decision);
    else this.scheduleReconnect(decision.delayMs, decision.attempt);
  }

  private scheduleReconnect(delayMs: number, attempt: number): void {
    this.phase = "waiting";
    this.options.store.setStatus("baileys", "disconnected", this.now(), `Reconectando (intento ${attempt}).`);
    this.options.log.warn({ attempt, delayMs }, "whatsapp connection closed, reconnecting");
    this.reconnectTimer = setTimeout(() => this.open(), delayMs);
  }

  private halt(decision: Extract<CloseDecision, { action: "stop" }>): void {
    if (decision.clearSession) this.options.auth.clear();
    this.options.store.refreshSyncState("baileys", decision.status, this.now(), decision.detail);
    this.phase = "stopped";
    this.options.log.warn({ status: decision.status }, "whatsapp bridge stopped, it will not reconnect on its own");
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.stableTimer);
    this.reconnectTimer = this.heartbeat = this.stableTimer = undefined;
  }
}
