import type { Card, ClientMessage, HistoryItem, OutgoingServerMessage } from "@jarvis/contracts";
import type { Transport, TransportFactory, TransportHandlers } from "../protocol/client.js";

const TIME_ZONE = "America/Argentina/Buenos_Aires";
const DEMO_VIDEO = { videoId: "jNQXAC9IVRw", title: "Video de ejemplo", channel: "Canal ficticio" };

export interface DemoOptions {
  /** Pause between scripted steps, in milliseconds. */
  stepMs: number;
  now?: () => Date;
}

type Out = OutgoingServerMessage;

function uuid(counter: number): string {
  return `d3d30d3d-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function inAt(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function demoHistory(now: Date): HistoryItem[] {
  const cards = (list: Card[]) => list;
  return [
    { id: "demo-1", turnId: uuid(1), role: "user", text: "¿Qué tengo para mañana?", at: inAt(now, -42), interrupted: false, cards: [] },
    {
      id: "demo-2",
      turnId: uuid(1),
      role: "assistant",
      text: "Mañana tenés una reunión con Ana a media mañana y un recordatorio para llamar al dentista.",
      at: inAt(now, -42),
      interrupted: false,
      cards: cards([
        { kind: "event", eventId: "e1", title: "Reunión con Ana (ficticia)", start: inAt(now, 60 * 24 + 600 - 180), end: inAt(now, 60 * 24 + 660 - 180), timezone: TIME_ZONE, location: "Oficina" },
        { kind: "reminder", reminderId: "r1", text: "Llamar al dentista", dueAt: inAt(now, 60 * 24 + 900 - 180), timezone: TIME_ZONE, status: "scheduled" },
      ]),
    },
    { id: "demo-3", turnId: uuid(2), role: "user", text: "Buscame novedades sobre energía solar en Argentina", at: inAt(now, -30), interrupted: false, cards: [] },
    {
      id: "demo-4",
      turnId: uuid(2),
      role: "assistant",
      text: "Encontré dos notas recientes. Te dejo las fuentes.",
      at: inAt(now, -30),
      interrupted: false,
      cards: cards([
        {
          kind: "sources",
          items: [
            { title: "Nota de ejemplo sobre paneles solares", url: "https://example.com/solar", source: "Diario Ficticio", date: "2026-10-20" },
            { title: "Informe de ejemplo sobre energía", url: "https://example.com/energia", source: "Revista Ficticia", date: "2026-10-18" },
          ],
        },
      ]),
    },
  ];
}

function confirmCard(now: Date, status: "pending" | "confirmed" | "rejected"): Card {
  return {
    kind: "confirm",
    actionId: "demo-action",
    title: "Enviar correo (demo)",
    summary: "Voy a enviar un correo de prueba a una persona ficticia.",
    details: [
      { label: "Para", value: "ana@example.com" },
      { label: "Asunto", value: "Reunión de mañana" },
    ],
    expiresAt: inAt(now, 30),
    status,
  };
}

function reply(text: string, now: Date): { text: string; cards: Card[] } {
  const lower = text.toLowerCase();
  if (lower.includes("recordatorio") || lower.includes("recordame")) {
    return {
      text: "Listo, te lo anoté.",
      cards: [{ kind: "reminder", reminderId: "r-new", text: "Revisar el informe", dueAt: inAt(now, 120), timezone: TIME_ZONE, status: "scheduled" }],
    };
  }
  if (lower.includes("video") || lower.includes("música") || lower.includes("musica")) {
    return {
      text: "Te dejo el reproductor. Tocá reproducir cuando quieras.",
      cards: [{ kind: "youtube", requestId: "demo-video", ...DEMO_VIDEO, url: `https://www.youtube.com/watch?v=${DEMO_VIDEO.videoId}`, autoplay: false }],
    };
  }
  if (lower.includes("correo") || lower.includes("mail")) {
    return { text: "Antes de enviarlo necesito que lo confirmes.", cards: [confirmCard(now, "pending")] };
  }
  return { text: "Esto es el modo demo: respondo con datos ficticios. Probá pedirme un recordatorio, un video o enviar un correo.", cards: [] };
}

/** A scripted stand-in for the server: fictitious data, no network. Used for screenshots and development. */
export class DemoServer {
  private seq = 0;
  private counter = 100;
  private conversation = uuid(1000);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly handlers: TransportHandlers,
    private readonly options: DemoOptions,
  ) {}

  open(): void {
    this.handlers.open();
  }

  close(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  receive(message: ClientMessage): void {
    switch (message.type) {
      case "hello":
        this.attach(false);
        break;
      case "conversation.new":
        this.conversation = uuid(++this.counter);
        this.attach(true);
        break;
      case "user.text":
        this.runTurn(message.turnId, message.text);
        break;
      case "turn.cancel":
        this.close();
        this.emit({ type: "state", state: "idle" });
        break;
      case "action.decide":
        this.emit({ type: "card", card: confirmCard(this.now(), message.decision === "confirm" ? "confirmed" : "rejected") });
        break;
      case "ping":
        this.emit({ type: "pong", t: message.t });
        break;
      default:
        break;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private emit(message: Out): void {
    this.handlers.text(JSON.stringify({ ...message, seq: ++this.seq }));
  }

  private later(step: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, this.options.stepMs * step);
    this.timers.add(timer);
  }

  private attach(empty: boolean): void {
    this.emit({
      type: "ready",
      protocol: 1,
      conversationId: this.conversation,
      owner: { displayName: "Demo" },
      capabilities: { stt: false, tts: false, ttsProvider: null, outputFormat: null, followUpWindowMs: 12_000, pushPublicKey: null },
    });
    this.emit({ type: "history", conversationId: this.conversation, items: empty ? [] : demoHistory(this.now()), hasMore: false });
    this.emit({ type: "state", state: "idle" });
  }

  private runTurn(turnId: string, text: string): void {
    const answer = reply(text, this.now());
    this.emit({ type: "state", state: "thinking", turnId });
    this.later(2, () => this.emit({ type: "state", state: "using_tool", turnId, tool: "demo" }));
    this.later(4, () => {
      this.emit({ type: "state", state: "thinking", turnId });
      this.emit({ type: "assistant.delta", turnId, text: answer.text.slice(0, Math.ceil(answer.text.length / 2)) });
    });
    this.later(5, () => {
      this.emit({ type: "assistant.delta", turnId, text: answer.text.slice(Math.ceil(answer.text.length / 2)) });
      for (const card of answer.cards) this.emit({ type: "card", turnId, card });
      this.emit({ type: "assistant.done", turnId, messageId: `demo-reply-${turnId}`, text: answer.text, interrupted: false });
      this.emit({ type: "turn.end", turnId, status: "completed" });
      this.emit({ type: "state", state: "idle" });
    });
  }
}

export function demoTransport(options: DemoOptions = { stepMs: 700 }): TransportFactory {
  return (_url, handlers): Transport => {
    const server = new DemoServer(handlers, options);
    queueMicrotask(() => server.open());
    return {
      send: (data) => {
        if (typeof data === "string") server.receive(JSON.parse(data) as ClientMessage);
      },
      close: () => server.close(),
    };
  };
}
