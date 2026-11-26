import type { ActivityPhase } from "@jarvis/contracts";

/** One change of a scripted tool call, `at` steps after the turn starts (a step is the demo's pause). */
export interface ScriptedChange {
  at: number;
  call: string;
  tool: string;
  phase: ActivityPhase;
  errorCode?: string;
}

export interface ActivityScenario {
  changes: ScriptedChange[];
  /** When the reply starts, in steps. */
  replyAt: number;
  text: string;
}

function run(call: string, tool: string, start: number, end: number, outcome: "succeeded" | "failed" = "succeeded", errorCode?: string): ScriptedChange[] {
  return [
    { at: start, call, tool, phase: "preparing" },
    { at: start + 0.4, call, tool, phase: "running" },
    { at: end, call, tool, phase: outcome, ...(errorCode ? { errorCode } : {}) },
  ];
}

function stuck(call: string, tool: string, start: number, waitingAt: number): ScriptedChange[] {
  return [
    { at: start, call, tool, phase: "preparing" },
    { at: start + 0.4, call, tool, phase: "running" },
    { at: waitingAt, call, tool, phase: "waiting" },
  ];
}

const scenarios: { match: RegExp; build(): ActivityScenario }[] = [
  {
    match: /r[áa]pid/,
    build: () => ({ changes: run("a", "gmail_search", 1, 1.6), replyAt: 2.4, text: "Encontré tres correos de Ana (datos ficticios)." }),
  },
  {
    match: /lent/,
    build: () => ({ changes: [...stuck("a", "drive_search", 1, 4), { at: 9, call: "a", tool: "drive_search", phase: "succeeded" }], replyAt: 10, text: "Encontré el documento en Drive (dato ficticio)." }),
  },
  {
    match: /secuencia/,
    build: () => ({
      changes: [...run("a", "gmail_search", 1, 3), ...run("b", "calendar_list", 4, 6), ...run("c", "WebSearch", 7, 9.5)],
      replyAt: 10.5,
      text: "Revisé tu correo, tu agenda y la web. Todo es ficticio.",
    }),
  },
  {
    match: /paralel/,
    build: () => ({
      changes: [...run("a", "gmail_search", 1, 5), ...run("b", "drive_search", 1.2, 7), ...run("c", "WebSearch", 1.4, 4), ...run("d", "whatsapp_search", 1.6, 6)],
      replyAt: 8,
      text: "Busqué en cuatro lugares a la vez (datos ficticios).",
    }),
  },
  {
    match: /reintent/,
    build: () => ({
      changes: [...run("a", "gmail_search", 1, 2.5, "failed", "upstream_error"), ...run("b", "gmail_search", 3.5, 5)],
      replyAt: 6,
      text: "Gmail no respondió la primera vez; al reintentar funcionó (ficticio).",
    }),
  },
  {
    match: /fall/,
    build: () => ({
      changes: run("a", "drive_search", 1, 3, "failed", "auth_expired"),
      replyAt: 4,
      text: "No pude buscar en Drive porque hay que reconectarlo (ficticio).",
    }),
  },
  {
    match: /larga|cancel/,
    build: () => ({ changes: stuck("a", "drive_upload", 1, 5), replyAt: 60, text: "Esto no debería verse: la tarea larga se cancela antes." }),
  },
  {
    match: /desconocid/,
    build: () => ({ changes: run("a", "herramienta_nueva_sin_logo", 1, 3), replyAt: 4, text: "Usé una herramienta que todavía no tiene ícono propio (ficticio)." }),
  },
  {
    match: /confirmar/,
    build: () => ({
      changes: [...run("a", "gmail_search", 1, 2), { at: 3, call: "b", tool: "gmail_send", phase: "preparing" }, { at: 3.4, call: "b", tool: "gmail_send", phase: "running" }, { at: 4, call: "b", tool: "gmail_send", phase: "needs_approval" }],
      replyAt: 5,
      text: "Dejé el correo listo; falta que lo confirmes (ficticio).",
    }),
  },
];

/** The scripted tool activity for a message, if its words ask for one. */
export function activityScenario(text: string): ActivityScenario | undefined {
  const lower = text.toLowerCase();
  return scenarios.find((scenario) => scenario.match.test(lower))?.build();
}
