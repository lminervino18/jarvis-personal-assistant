import type { AuthenticationState, BaileysEventMap } from "baileys";
import type { Logger } from "pino";
import { WhatsAppEventHandlers } from "./event-handlers.js";
import type { WaSyncStatus, WhatsAppStore } from "./message-store.js";
import type { DbAuthState } from "./auth-state.js";
import { OWN_CHAT, type WhatsAppOutbox } from "./outbox.js";
import type { PairingStore } from "./pairing-store.js";
import type { CloseDecision, ReconnectPolicy } from "./reconnect-policy.js";

/** What the bridge sends: plain text, or a file as a photo, video, audio or document (with a caption where WhatsApp allows one). */
export type OutgoingContent =
  | { text: string }
  | { image: Buffer; caption: string; mimetype: string }
  | { video: Buffer; caption: string; mimetype: string }
  | { audio: Buffer; mimetype: string; ptt: boolean }
  | { document: Buffer; mimetype: string; fileName: string; caption: string };

/** A message as Baileys needs it to show it quoted above a reply. */
export interface QuotedWaMessage {
  key: { remoteJid: string; id: string; fromMe: boolean; participant?: string };
  message: { conversation: string };
}

/** The owner's own chat id from the paired device id ("5491100000000:12@s.whatsapp.net" → "5491100000000@s.whatsapp.net"). */
export function ownChat(deviceId: string | undefined): string | undefined {
  const user = deviceId?.split("@")[0]?.split(":")[0];
  return user ? `${user}@s.whatsapp.net` : undefined;
}

const HEARTBEAT_MS = 60_000;
const STABLE_MS = 120_000;
const QR_VALID_MS = 60_000;
/** WhatsApp keeps a pairing code valid for a few minutes. */
const CODE_VALID_MS = 3 * 60_000;
const OUTBOX_POLL_MS = 3_000;
const WAKE_POLL_MS = 5_000;
const SLOW_RETRY_FROM_MS = 10 * 60_000;
const NEEDS_PAIRING = "Hay que vincular WhatsApp: abrí Configuración y escaneá el QR.";

/** The slice of a Baileys socket the bridge uses: events, plus sending a text the owner confirmed. */
export interface BridgeSocket {
  ev: { on<E extends keyof BaileysEventMap>(event: E, listener: (data: BaileysEventMap[E]) => void): void };
  end(error: Error | undefined): void;
  sendMessage(jid: string, content: OutgoingContent, options?: { quoted?: QuotedWaMessage }): Promise<{ key?: { id?: string | null } } | undefined>;
  /** Asks WhatsApp for a code to link this device by phone number instead of a QR. */
  requestPairingCode?(phoneNumber: string): Promise<string>;
}

export interface BridgeOptions {
  store: WhatsAppStore;
  auth: Pick<DbAuthState, "state" | "saveCreds" | "clear">;
  pairing: Pick<PairingStore, "publish" | "publishCode" | "takeCodeRequest" | "clear" | "publishAccount" | "forgetAccount">;
  /** Messages the owner confirmed. Without it the bridge never sends anything. */
  outbox?: Pick<WhatsAppOutbox, "claimNext" | "markSent" | "markFailed" | "abandonInterrupted">;
  /** Reads chat attachments for outgoing photos and documents. */
  files?: { read(id: string): { attachment: { name: string; mediaType: string }; data: Buffer } | undefined };
  connect(auth: AuthenticationState): BridgeSocket;
  policy: ReconnectPolicy;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => Date;
}

export type BridgePhase = "idle" | "connecting" | "open" | "waiting" | "stopped";

const statusCodeOf = (error: unknown): number | undefined => (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * WhatsApp session. It reacts to events and records them, and sends only texts the owner
 * confirmed through the outbox, one at a time. It never sends receipts or presence, and reconnects
 * with capped backoff, then once every half hour. When the session is signed out or invalid, or
 * WhatsApp refuses it, it waits for the owner: opening Configuración asks it to connect again, with
 * a fresh QR when there is no session. It never offers QR codes nobody asked for.
 */
export class WhatsAppBridge {
  phase: BridgePhase = "idle";
  private socket?: BridgeSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private outboxTimer?: NodeJS.Timeout;
  private wakeTimer?: NodeJS.Timeout;
  private sending = false;
  /** Set while linking by code: the number, and whether the code was already asked for on this socket. */
  private codeFor?: { phone: string; asked: boolean };
  private readonly handlers: WhatsAppEventHandlers;
  private readonly now: () => Date;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.handlers = new WhatsAppEventHandlers(options.store, this.now);
    const abandoned = options.outbox?.abandonInterrupted(this.now()) ?? 0;
    if (abandoned > 0) options.log.warn({ abandoned }, "whatsapp messages interrupted while sending were not retried");
  }

  start(): void {
    if (this.phase !== "idle") return;
    if (this.options.auth.state.creds.me) this.open();
    else this.waitForOwner("logged_out", NEEDS_PAIRING);
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
    clearInterval(this.wakeTimer);
    this.wakeTimer = undefined;
    this.options.store.takeWake(this.now());
    const phone = this.options.auth.state.creds.me ? undefined : this.options.pairing.takeCodeRequest();
    this.codeFor = phone ? { phone, asked: false } : undefined;
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
      if (update.qr) {
        if (!this.codeFor) {
          const phone = this.options.pairing.takeCodeRequest();
          if (phone) this.codeFor = { phone, asked: false };
        }
        if (this.codeFor) void this.requestCode(socket, this.codeFor);
        else this.publishQr(update.qr);
      }
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

  /** Links by phone number: asks WhatsApp once per socket for the code the owner types in the app. */
  private async requestCode(socket: BridgeSocket, request: { phone: string; asked: boolean }): Promise<void> {
    if (request.asked || !socket.requestPairingCode) return;
    request.asked = true;
    try {
      const code = await socket.requestPairingCode(request.phone);
      const now = this.now();
      this.options.pairing.publishCode(code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code, new Date(now.getTime() + CODE_VALID_MS), now);
      this.options.store.setStatus("baileys", "pairing", now, "Escribí el código en WhatsApp: Dispositivos vinculados › Vincular con número de teléfono.");
    } catch (error) {
      this.options.log.warn({ error: errorName(error) }, "whatsapp pairing code could not be requested");
      this.options.store.setStatus("baileys", "logged_out", this.now(), "WhatsApp no dio el código de vinculación. Probá de nuevo o usá el QR.");
    }
  }

  private handleOpen(): void {
    this.phase = "open";
    this.options.pairing.clear();
    this.options.store.refreshSyncState("baileys", "connected", this.now());
    this.heartbeat = setInterval(() => this.options.store.setStatus("baileys", "connected", this.now()), HEARTBEAT_MS);
    this.stableTimer = setTimeout(() => this.options.policy.reset(), STABLE_MS);
    if (this.options.outbox) this.outboxTimer = setInterval(() => void this.sendNextConfirmed(), OUTBOX_POLL_MS);
    const me = this.options.auth.state.creds.me;
    const number = me?.id ? ownChat(me.id)?.split("@")[0] : undefined;
    if (number) this.options.pairing.publishAccount({ number, ...(me?.name ? { name: me.name } : {}) }, this.now());
    this.options.log.info("whatsapp connection open");
  }

  /** Sends the oldest confirmed message, at most once: it is claimed before the socket call. */
  async sendNextConfirmed(): Promise<void> {
    const { outbox } = this.options;
    const socket = this.socket;
    if (!outbox || !socket || this.phase !== "open" || this.sending) return;
    const message = outbox.claimNext(this.now());
    if (!message) return;
    this.sending = true;
    try {
      const target = message.chatJid === OWN_CHAT ? ownChat(this.options.auth.state.creds.me?.id) : message.chatJid;
      if (!target) throw new Error("own number unknown");
      let sent: Awaited<ReturnType<BridgeSocket["sendMessage"]>>;
      const quoted: QuotedWaMessage | undefined = message.quote
        ? { key: { remoteJid: target, id: message.quote.id, fromMe: message.quote.fromMe, ...(message.quote.participant ? { participant: message.quote.participant } : {}) }, message: { conversation: message.quote.text } }
        : undefined;
      for (const [index, content] of this.contents(message).entries()) sent = await socket.sendMessage(target, content, index === 0 && quoted ? { quoted } : undefined);
      outbox.markSent(message.id, sent?.key?.id ?? undefined, this.now());
      this.options.log.info("whatsapp message sent");
    } catch (error) {
      outbox.markFailed(message.id, errorName(error), this.now());
      this.options.log.warn({ error: errorName(error) }, "whatsapp message could not be sent");
    } finally {
      this.sending = false;
    }
  }

  /** One message, or the text and then the audio, since WhatsApp audios carry no caption. */
  private contents(message: { text: string; attachmentId?: string }): OutgoingContent[] {
    if (!message.attachmentId) return [{ text: message.text }];
    const file = this.options.files?.read(message.attachmentId);
    if (!file) throw new Error("attachment missing");
    const { mediaType, name } = file.attachment;
    if (mediaType.startsWith("image/")) return [{ image: file.data, caption: message.text, mimetype: mediaType }];
    if (mediaType.startsWith("video/")) return [{ video: file.data, caption: message.text, mimetype: mediaType }];
    if (mediaType.startsWith("audio/")) {
      const audio: OutgoingContent = { audio: file.data, mimetype: mediaType, ptt: mediaType.includes("ogg") || mediaType.includes("opus") };
      return message.text.trim() ? [{ text: message.text }, audio] : [audio];
    }
    return [{ document: file.data, mimetype: mediaType, fileName: name, caption: message.text }];
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
    const detail = delayMs >= SLOW_RETRY_FROM_MS ? `Sin conexión; vuelvo a probar en ${Math.round(delayMs / 60_000)} minutos.` : `Reconectando (intento ${attempt}).`;
    this.options.store.setStatus("baileys", "disconnected", this.now(), detail);
    this.options.log.warn({ attempt, delayMs }, "whatsapp connection closed, reconnecting");
    this.reconnectTimer = setTimeout(() => this.open(), delayMs);
    this.watchForWake();
  }

  private halt(decision: Extract<CloseDecision, { action: "stop" }>): void {
    if (decision.clearSession) {
      this.options.auth.clear();
      this.options.pairing.forgetAccount();
    }
    this.options.log.warn({ status: decision.status }, "whatsapp bridge stopped, waiting for the owner to reconnect it");
    this.waitForOwner(decision.status, decision.detail);
  }

  /** Stays down until the owner asks for a connection from Configuración. */
  private waitForOwner(status: WaSyncStatus, detail: string): void {
    this.options.store.refreshSyncState("baileys", status, this.now(), detail);
    this.phase = "stopped";
    this.watchForWake();
  }

  /** While disconnected, the owner can ask from Configuración to connect right now. */
  private watchForWake(): void {
    this.wakeTimer = setInterval(() => {
      if (!this.options.store.takeWake(this.now())) return;
      this.options.log.info("whatsapp reconnection asked by the owner");
      clearTimeout(this.reconnectTimer);
      this.options.policy.reset();
      this.open();
    }, WAKE_POLL_MS);
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.stableTimer);
    clearInterval(this.outboxTimer);
    clearInterval(this.wakeTimer);
    this.reconnectTimer = this.heartbeat = this.stableTimer = this.outboxTimer = this.wakeTimer = undefined;
  }
}
