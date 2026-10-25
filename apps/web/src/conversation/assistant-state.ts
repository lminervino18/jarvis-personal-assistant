import type { AssistantState, ServerAssistantState } from "@jarvis/contracts";
import type { ConnectionStatus } from "../protocol/client.js";

export interface StateFacts {
  connection: ConnectionStatus;
  server: ServerAssistantState;
  /** The microphone is inside an utterance (speech confirmed, not yet ended). */
  capturing: boolean;
  /** The microphone is open and waiting for the owner to speak. */
  micOpen: boolean;
  /** Speech audio is being played on this device. */
  playing: boolean;
}

/**
 * Combines what the server reports with what only the device knows. Every returned state
 * comes from a real fact: the socket, the microphone, the playback or a server event.
 */
export function deriveState(facts: StateFacts): AssistantState {
  if (facts.connection === "connecting") return "connecting";
  if (facts.connection !== "ready") return "offline";
  if (facts.capturing) return "listening";
  if (facts.playing) return "speaking";
  if (facts.server !== "idle") return facts.server;
  return facts.micOpen ? "listening" : "idle";
}

const labels: Record<AssistantState, string> = {
  offline: "Sin conexión",
  connecting: "Conectando",
  idle: "Listo",
  listening: "Escuchando",
  transcribing: "Transcribiendo",
  thinking: "Pensando",
  using_tool: "Consultando",
  speaking: "Hablando",
  interrupted: "Interrumpido",
  error: "Hubo un problema",
};

export function stateLabel(state: AssistantState): string {
  return labels[state];
}

const busyStates: ReadonlySet<AssistantState> = new Set(["transcribing", "thinking", "using_tool", "speaking"]);

/** True while there is something to cut: a running turn, speech playing or an utterance being captured. */
export function isBusy(state: AssistantState, capturing: boolean): boolean {
  return capturing || busyStates.has(state);
}
