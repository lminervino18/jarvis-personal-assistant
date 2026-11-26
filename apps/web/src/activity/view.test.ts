import { describe, expect, it } from "vitest";
import type { ExecutionPhase, TurnActivityView } from "./activity-store.js";
import { describeActivity } from "./view.js";

const run = (id: string, tool: string, phase: ExecutionPhase, errorCode?: string) => ({ id, tool, phase, version: 1, ...(errorCode ? { errorCode } : {}) });
const turn = (executions: TurnActivityView["executions"], stage: TurnActivityView["stage"] = "thinking"): TurnActivityView => ({ turnId: "t", executions, stage });

describe("describeActivity", () => {
  it("says Pensando before anything else happens, and nothing once the reply started", () => {
    expect(describeActivity(turn([]))).toMatchObject({ tone: "working", title: "Pensando…" });
    expect(describeActivity(turn([], "replying"))).toBeNull();
  });

  it("separates preparing, running and waiting of the same call", () => {
    expect(describeActivity(turn([run("1", "youtube_open", "preparing")]))?.title).toBe("Preparando YouTube…");
    expect(describeActivity(turn([run("1", "youtube_open", "running")]))?.title).toBe("Abriendo YouTube…");
    expect(describeActivity(turn([run("1", "drive_search", "waiting")]))?.title).toBe("Esperando la respuesta de Google Drive…");
  });

  it("summarizes parallel calls in one line instead of switching texts", () => {
    const view = describeActivity(turn([run("1", "gmail_search", "running"), run("2", "drive_search", "running"), run("3", "WebSearch", "running")]));
    expect(view).toMatchObject({ tone: "working", title: "Trabajando en 3 cosas…" });
    expect(view?.items).toHaveLength(3);
    expect(view?.visuals).toHaveLength(3);
  });

  it("keeps a sequence honest between calls", () => {
    const view = describeActivity(turn([run("1", "gmail_search", "succeeded")], "thinking"));
    expect(view).toMatchObject({ tone: "working", title: "Procesando el resultado…" });
  });

  it("resolves into a compact summary once the reply is under way", () => {
    expect(describeActivity(turn([run("1", "gmail_search", "succeeded")], "replying"))).toMatchObject({ tone: "done", title: "Gmail consultado" });
    expect(describeActivity(turn([run("1", "gmail_search", "succeeded"), run("2", "calendar_list", "succeeded")], "ended"))).toMatchObject({
      tone: "done",
      title: "2 acciones realizadas",
    });
  });

  it("tells failure, cancellation, pending approval and lost connection apart, with text", () => {
    expect(describeActivity(turn([run("1", "gmail_search", "failed", "upstream_error")], "ended"))).toMatchObject({ tone: "problem", title: "Gmail no respondió" });
    expect(describeActivity(turn([run("1", "gmail_search", "succeeded"), run("2", "drive_search", "failed")], "ended"))).toMatchObject({ tone: "problem", title: "1 acción falló de 2" });
    expect(describeActivity(turn([run("1", "WebSearch", "cancelled")], "ended"))).toMatchObject({ tone: "cancelled", title: "Cancelado" });
    expect(describeActivity(turn([run("1", "gmail_send", "needs_approval")], "ended"))).toMatchObject({ tone: "approval", title: "Confirmación solicitada" });
    expect(describeActivity(turn([run("1", "gmail_search", "interrupted")], "thinking"))).toMatchObject({ tone: "offline", title: "Sin conexión" });
  });

  it("presents a tool it does not know with a generic icon", () => {
    const view = describeActivity(turn([run("1", "new_scanner", "running")]));
    expect(view?.title).toBe("Usando New scanner…");
    expect(view?.visuals).toEqual([{ kind: "glyph", name: "bolt" }]);
  });
});
