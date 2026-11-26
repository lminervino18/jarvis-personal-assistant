import type { Card, ClientMessage, HistoryItem, OutgoingServerMessage } from "@jarvis/contracts";
import { activityScenario, type ActivityScenario, type ScriptedChange } from "./activity-scenarios.js";
import type { Transport, TransportFactory, TransportHandlers } from "../protocol/client.js";

const TIME_ZONE = "America/Argentina/Buenos_Aires";
const DEMO_VIDEO = { videoId: "jNQXAC9IVRw", title: "Video de ejemplo", channel: "Canal ficticio" };

export interface DemoOptions {
  /** Pause between scripted steps, in milliseconds. */
  stepMs: number;
  /** Pretends the server can transcribe and speak, to show the voice controls. */
  voice?: boolean;
  now?: () => Date;
}

type Out = OutgoingServerMessage;

function uuid(counter: number): string {
  return `d3d30d3d-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function inAt(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

const BUENOS_AIRES_OFFSET_HOURS = 3;

function tomorrowAt(now: Date, hour: number, minute = 0): string {
  const local = new Date(now.getTime() - BUENOS_AIRES_OFFSET_HOURS * 3_600_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return new Date(midnight + (hour + BUENOS_AIRES_OFFSET_HOURS) * 3_600_000 + minute * 60_000).toISOString();
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
        { kind: "event", eventId: "e1", title: "Reunión con Ana (ficticia)", start: tomorrowAt(now, 10), end: tomorrowAt(now, 11), timezone: TIME_ZONE, location: "Oficina" },
        { kind: "reminder", reminderId: "r1", text: "Llamar al dentista", dueAt: tomorrowAt(now, 15, 30), timezone: TIME_ZONE, status: "scheduled" },
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
    { id: "demo-5", turnId: uuid(3), role: "user", text: "¿Cómo vienen mis tareas?", at: inAt(now, -12), interrupted: false, cards: [] },
    {
      id: "demo-6",
      turnId: uuid(3),
      role: "assistant",
      text: "La migración de pagos va adelantada; el informe trimestral espera tu respuesta.",
      at: inAt(now, -12),
      interrupted: false,
      cards: cards(DEMO_TASK_CARDS),
    },
  ];
}

const DEMO_TASK_CARDS: Card[] = [
  {
    kind: "chart",
    title: "Avance de tareas (ficticio)",
    chart: "progress",
    labels: ["#3 Migración de pagos", "#4 Informe trimestral", "#5 Tests de facturación"],
    series: [{ name: "Avance", values: [80, 45, 20] }],
    unit: "%",
  },
  {
    kind: "table",
    title: "Detalle",
    columns: ["#", "Tarea", "Estado"],
    rows: [
      ["3", "Migración de pagos", "En revisión"],
      ["4", "Informe trimestral", "Espera respuesta"],
      ["5", "Tests de facturación", "Ejecutando"],
    ],
  },
];

function buildTasks(now: Date): Extract<Card, { kind: "task" }>[] {
  const base = { status: "ready" as const, phase: null, paused: false, iteration: 1, costUsd: 0.18, budgetUsd: 5, build: true, updatedAt: now.toISOString() };
  return [
    {
      ...base,
      kind: "task",
      taskId: uuid(900),
      ref: 14,
      title: "Botón para repetir la última respuesta (ficticio)",
      summary: "Agregué un botón «Repetir» en cada respuesta que vuelve a reproducir el audio, con tests.",
      review: { verdict: "approve", passed: 4, total: 4 },
    },
    {
      ...base,
      kind: "task",
      taskId: uuid(901),
      ref: 12,
      status: "accepted",
      title: "Modo oscuro más contrastado (ficticio)",
      publication: { status: "published", step: "deploy", commit: "a1b2c3d4e5f6" },
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

const STRESS_TEXT = [
  "Esta es una respuesta larga para probar la lectura: tiene **negritas**, _itálicas_, una lista y código.",
  "",
  "1. Primero revisé el archivo `apps/web/src/ui/Conversation.tsx`, que es bastante largo.",
  "2. Después comparé contra https://example.com/una/url/muy/larga/que/no/deberia/romper/el/ancho/del/chat?con=parametros&y=mas&parametros=todavia",
  "3. Por último armé este bloque:",
  "",
  "```ts",
  "export function sumarTodosLosValoresDeUnaListaMuyLarga(valores: readonly number[]): number { return valores.reduce((total, valor) => total + valor, 0); }",
  "```",
  "",
  "Un párrafo final más largo, para ver cómo respira el texto cuando ocupa varias líneas en un celular angosto y en una pantalla ancha de escritorio, sin estirarse de más ni quedar apretado contra los bordes.",
].join("\n");

function stressCards(): Card[] {
  return [
    { kind: "table", title: "Comparación con un título bastante largo para ver cómo se corta", columns: ["Archivo", "Líneas", "Estado", "Notas"], rows: [["apps/web/src/ui/Conversation.tsx", "231", "Revisado", "Sin problemas"], ["apps/server/src/ws/client-connection.ts", "612", "Pendiente", "Revisar el manejo de capturas en llamadas largas"]] },
    { kind: "attachment", attachmentId: "d3d30d3d-0000-4000-8000-00000000a001", name: "informe-trimestral-de-ventas-por-region-version-final-revisada-2026.pdf", mediaType: "application/pdf", size: 482_133 },
    { kind: "link", url: "https://example.com/una/url/muy/larga/que/no/deberia/romper/el/ancho/del/chat?con=parametros&y=mas", title: "Un enlace con un título largo que tiene que poder leerse entero o cortarse con criterio", description: "Descripción del enlace (ficticia)." },
  ];
}

function narratedVideos(now: Date): Card[] {
  const base = { kind: "video", title: "Resumen de la semana (ficticio)", format: "vertical", updatedAt: now.toISOString() } as const;
  return [
    { ...base, videoId: uuid(9001), version: 1, status: "render", progress: 0.42, files: {} },
    {
      ...base,
      videoId: uuid(9002),
      version: 2,
      status: "ready",
      progress: 1,
      durationMs: 10_000,
      files: { full: { attachmentId: uuid(9003), size: 4_200_000 }, light: { attachmentId: uuid(9004), size: 1_100_000 } },
    },
  ];
}

function reply(text: string, now: Date): { text: string; cards: Card[] } {
  const lower = text.toLowerCase();
  if (lower.includes("prueba")) return { text: STRESS_TEXT, cards: stressCards() };
  if (lower.includes("opciones")) {
    return {
      text: "Encontré tres versiones (datos ficticios): tocá la que es y la bajo en MP3.",
      cards: [
        {
          kind: "media_choice",
          choiceId: "00000000-0000-4000-8000-0000000000c1",
          format: "mp3",
          sendTo: "Marti",
          options: [
            { videoId: "aaaaaaaaaaa", title: "Gustavo Cerati - Crimen (Official Video)", channel: "Gustavo Cerati", duration: 253, thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg" },
            { videoId: "bbbbbbbbbbb", title: "Gustavo Cerati - Crimen (En vivo en el Gran Rex, versión acústica con orquesta y un título largo)", channel: "Cerati Oficial", duration: 312, thumbnailUrl: "https://i.ytimg.com/vi/bbbbbbbbbbb/mqdefault.jpg" },
            { videoId: "ccccccccccc", title: "Crimen - cover", channel: "Canal de covers", thumbnailUrl: "https://i.ytimg.com/vi/ccccccccccc/mqdefault.jpg" },
          ],
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        },
      ],
    };
  }
  if (lower.includes("narrado")) return { text: "Uno se está renderizando y el otro ya está (datos ficticios).", cards: narratedVideos(now) };
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
  if (lower.includes("tarea") || lower.includes("gráfico") || lower.includes("grafico")) {
    return { text: "Así vienen las tareas (datos ficticios).", cards: DEMO_TASK_CARDS };
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
  private readonly openCalls = new Map<string, { turnId: string; tool: string; version: number }>();

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
        this.cancelOpenCalls(message.turnId);
        this.emit({ type: "turn.end", turnId: message.turnId, status: "cancelled" });
        this.emit({ type: "state", state: "idle" });
        break;
      case "action.decide":
        this.emit({ type: "card", card: confirmCard(this.now(), message.decision === "confirm" ? "confirmed" : "rejected") });
        break;
      case "build.list":
        this.emit({ type: "build.tasks", tasks: buildTasks(this.now()) });
        break;
      case "build.request":
      case "build.feedback":
        this.emit({ type: "notice", level: "info", code: "build_updated", message: "Modo demo: el pedido no se envía a ningún agente." });
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
    const data = JSON.stringify({ ...message, seq: ++this.seq });
    queueMicrotask(() => this.handlers.text(data));
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
      capabilities: { stt: this.options.voice === true, tts: this.options.voice === true, ttsProvider: null, outputFormat: null, followUpWindowMs: 12_000, pushPublicKey: null },
    });
    this.emit({ type: "history", conversationId: this.conversation, items: empty ? [] : demoHistory(this.now()), hasMore: false });
    this.emit({ type: "state", state: "idle" });
  }

  private change(turnId: string, step: ScriptedChange): void {
    const id = `${turnId}:${step.call}`;
    const known = this.openCalls.get(id);
    const version = (known?.version ?? 0) + 1;
    const final = step.phase === "succeeded" || step.phase === "failed" || step.phase === "needs_approval" || step.phase === "cancelled";
    if (final) this.openCalls.delete(id);
    else this.openCalls.set(id, { turnId, tool: step.tool, version });
    this.emit({
      type: "activity",
      conversationId: this.conversation,
      turnId,
      executionId: id,
      tool: step.tool,
      phase: step.phase,
      version,
      at: this.now().getTime(),
      ...(step.errorCode ? { errorCode: step.errorCode } : {}),
    });
  }

  private cancelOpenCalls(turnId: string): void {
    for (const [id, call] of [...this.openCalls]) {
      if (call.turnId === turnId) this.change(turnId, { at: 0, call: id.slice(turnId.length + 1), tool: call.tool, phase: "cancelled" });
    }
  }

  private runScenario(turnId: string, scenario: ActivityScenario): void {
    this.emit({ type: "state", state: "thinking", turnId });
    for (const step of scenario.changes) this.later(step.at, () => this.change(turnId, step));
    const pieces = scenario.text.match(/[\s\S]{1,24}/g) ?? [];
    pieces.forEach((piece, index) => this.later(scenario.replyAt + (index + 1) / 6, () => this.emit({ type: "assistant.delta", turnId, text: piece })));
    this.later(scenario.replyAt + 1 + pieces.length / 6, () => {
      this.emit({ type: "assistant.done", turnId, messageId: `demo-reply-${turnId}`, text: scenario.text, interrupted: false });
      this.emit({ type: "turn.end", turnId, status: "completed" });
      this.emit({ type: "state", state: "idle" });
    });
  }

  private runTurn(turnId: string, text: string): void {
    const scenario = activityScenario(text);
    if (scenario) return this.runScenario(turnId, scenario);
    const answer = reply(text, this.now());
    this.emit({ type: "state", state: "thinking", turnId });
    this.later(2, () => this.emit({ type: "state", state: "using_tool", turnId, tool: "demo" }));
    const pieces = answer.text.match(/[\s\S]{1,24}/g) ?? [];
    this.later(4, () => this.emit({ type: "state", state: "thinking", turnId }));
    pieces.forEach((piece, index) => this.later(4 + (index + 1) / 6, () => this.emit({ type: "assistant.delta", turnId, text: piece })));
    this.later(5 + pieces.length / 6, () => {
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
