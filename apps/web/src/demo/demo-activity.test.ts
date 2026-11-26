import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "../conversation/session.js";
import { describeActivity } from "../activity/view.js";
import { demoTransport } from "./demo-server.js";

const STEP = 10;

function demoSession() {
  return new Session({
    url: "ws://demo",
    transport: demoTransport({ stepMs: STEP, now: () => new Date("2026-10-24T15:00:00.000Z") }),
    createEngine: () => {
      throw new Error("the demo has no audio");
    },
  });
}

async function ask(text: string) {
  const session = demoSession();
  session.start();
  await vi.advanceTimersByTimeAsync(5);
  session.sendText(text);
  const turnId = session.getSnapshot().thread.messages.at(-1)?.turnId as string;
  return { session, turnId };
}

const view = (session: Session, turnId: string) => {
  const turn = session.activity.turn(turnId);
  return turn ? describeActivity(turn) : null;
};

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("activity in the demo", () => {
  it("shows Pensando first, then the real action, then a compact summary under the reply", async () => {
    const { session, turnId } = await ask("una búsqueda rápida");
    await vi.advanceTimersByTimeAsync(STEP * 0.5);
    expect(view(session, turnId)?.title).toBe("Pensando…");
    await vi.advanceTimersByTimeAsync(STEP * 0.7);
    expect(view(session, turnId)?.title).toBe("Preparando Gmail…");
    await vi.advanceTimersByTimeAsync(STEP * 0.3);
    expect(view(session, turnId)?.title).toBe("Buscando en Gmail…");
    await vi.advanceTimersByTimeAsync(STEP * 20);
    expect(view(session, turnId)).toMatchObject({ tone: "done", title: "Gmail consultado" });
    expect(session.getSnapshot().state).toBe("idle");
    session.stop();
  });

  it("reports waiting only after the call has been running for a while", async () => {
    const { session, turnId } = await ask("una búsqueda lenta");
    await vi.advanceTimersByTimeAsync(STEP * 2.5);
    expect(view(session, turnId)?.title).toBe("Buscando en Google Drive…");
    await vi.advanceTimersByTimeAsync(STEP * 2);
    expect(view(session, turnId)?.title).toBe("Esperando la respuesta de Google Drive…");
    await vi.advanceTimersByTimeAsync(STEP * 30);
    expect(view(session, turnId)?.tone).toBe("done");
    session.stop();
  });

  it("groups parallel calls in one summary and lists each of them", async () => {
    const { session, turnId } = await ask("cuatro búsquedas paralelas");
    await vi.advanceTimersByTimeAsync(STEP * 3);
    expect(view(session, turnId)).toMatchObject({ tone: "working", title: "Trabajando en 4 cosas…" });
    await vi.advanceTimersByTimeAsync(STEP * 40);
    expect(view(session, turnId)).toMatchObject({ tone: "done", title: "4 acciones realizadas" });
    session.stop();
  });

  it("shows an error and then the retry that worked", async () => {
    const { session, turnId } = await ask("un reintento");
    await vi.advanceTimersByTimeAsync(STEP * 3);
    expect(session.activity.turn(turnId)?.executions[0]).toMatchObject({ phase: "failed", errorCode: "upstream_error" });
    await vi.advanceTimersByTimeAsync(STEP * 30);
    expect(session.activity.turn(turnId)?.executions.map((execution) => execution.phase)).toEqual(["failed", "succeeded"]);
    expect(view(session, turnId)?.tone).toBe("problem");
    session.stop();
  });

  it("cancels the open call when the owner stops, and a late event does not complete it", async () => {
    const { session, turnId } = await ask("una tarea larga");
    await vi.advanceTimersByTimeAsync(STEP * 2);
    expect(view(session, turnId)?.tone).toBe("working");
    session.stopAll();
    await vi.advanceTimersByTimeAsync(STEP * 2);
    expect(session.activity.turn(turnId)?.executions.map((execution) => execution.phase)).toEqual(["cancelled"]);
    expect(session.activity.current()).toBeUndefined();
    session.stop();
  });

  it("keeps an unknown tool readable and a call stopped for approval apart from a success", async () => {
    const unknown = await ask("una herramienta desconocida");
    await vi.advanceTimersByTimeAsync(STEP * 2);
    expect(view(unknown.session, unknown.turnId)?.title).toBe("Usando Herramienta nueva sin logo…");
    unknown.session.stop();
    const approval = await ask("quiero confirmar un envío");
    await vi.advanceTimersByTimeAsync(STEP * 30);
    expect(view(approval.session, approval.turnId)).toMatchObject({ tone: "approval", title: "Confirmación solicitada" });
    approval.session.stop();
  });

  it("does not leave anything active when the connection drops, and says so without calling it a failure", async () => {
    const { session, turnId } = await ask("una búsqueda lenta");
    await vi.advanceTimersByTimeAsync(STEP * 2.5);
    session.stop();
    expect(session.activity.turn(turnId)?.executions.map((execution) => execution.phase)).toEqual(["interrupted"]);
    expect(view(session, turnId)).toMatchObject({ tone: "offline", title: "Sin conexión" });
  });
});
