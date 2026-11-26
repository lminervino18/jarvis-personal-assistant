import type { ActivityEvent } from "@jarvis/contracts";
import { describe, expect, it, vi } from "vitest";
import { ActivityStore } from "./activity-store.js";

const conversationId = "c1c1c1c1-0000-4000-8000-000000000001";
const turnId = "d1d1d1d1-0000-4000-8000-000000000001";

const event = (over: Partial<ActivityEvent>): ActivityEvent => ({
  conversationId,
  turnId,
  executionId: "t1",
  tool: "gmail_search",
  phase: "running",
  version: 1,
  at: 1,
  ...over,
});

const phases = (store: ActivityStore, id = turnId) => store.turn(id)?.executions.map((execution) => execution.phase);

describe("ActivityStore", () => {
  it("applies versions in order and ignores duplicates and late events", () => {
    const store = new ActivityStore();
    store.apply(event({ phase: "preparing", version: 1 }));
    store.apply(event({ phase: "running", version: 2 }));
    store.apply(event({ phase: "running", version: 2 }));
    store.apply(event({ phase: "preparing", version: 1 }));
    expect(phases(store)).toEqual(["running"]);
  });

  it("does not bring back a finished call or complete a cancelled one", () => {
    const store = new ActivityStore();
    store.apply(event({ phase: "cancelled", version: 3 }));
    store.apply(event({ phase: "running", version: 4 }));
    store.apply(event({ phase: "succeeded", version: 5 }));
    expect(phases(store)).toEqual(["cancelled"]);
  });

  it("ignores everything for a turn that ended, even a late success", () => {
    const store = new ActivityStore();
    store.apply(event({ phase: "running", version: 1 }));
    store.end(turnId, "cancelled");
    store.apply(event({ phase: "succeeded", version: 2 }));
    store.begin(turnId);
    expect(phases(store)).toEqual(["cancelled"]);
    expect(store.turn(turnId)?.stage).toBe("ended");
  });

  it("keeps calls of the same turn apart and different turns apart", () => {
    const store = new ActivityStore();
    const other = "d2d2d2d2-0000-4000-8000-000000000002";
    store.apply(event({ executionId: "a", phase: "running" }));
    store.apply(event({ executionId: "b", tool: "drive_search", phase: "failed", errorCode: "upstream_error" }));
    store.apply(event({ turnId: other, executionId: "a", phase: "succeeded" }));
    expect(phases(store)).toEqual(["running", "failed"]);
    expect(phases(store, other)).toEqual(["succeeded"]);
  });

  it("shows an interrupted call as interrupted, not as failed, and forgets it when reconnected", () => {
    const store = new ActivityStore();
    store.apply(event({ phase: "running" }));
    store.apply(event({ executionId: "done", phase: "succeeded" }));
    store.connectionLost();
    expect(phases(store)).toEqual(["interrupted", "succeeded"]);
    store.reconnected();
    expect(store.turn(turnId)).toBeUndefined();
    store.apply(event({ phase: "running", version: 2 }));
    expect(phases(store)).toEqual(["running"]);
  });

  it("moves from thinking to replying only once and ends with the outcome", () => {
    const store = new ActivityStore();
    const listener = vi.fn();
    store.begin(turnId);
    store.subscribe(listener);
    store.replying(turnId);
    store.replying(turnId);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.current()?.stage).toBe("replying");
    store.end(turnId, "completed");
    expect(store.current()).toBeUndefined();
    expect(store.turn(turnId)?.outcome).toBe("completed");
  });

  it("notifies only for changes and keeps the same view object when nothing changed", () => {
    const store = new ActivityStore();
    store.apply(event({ phase: "running", version: 2 }));
    const before = store.turn(turnId);
    const listener = vi.fn();
    store.subscribe(listener);
    store.apply(event({ phase: "running", version: 2 }));
    expect(listener).not.toHaveBeenCalled();
    expect(store.turn(turnId)).toBe(before);
  });

  it("bounds its memory: old finished turns and old finished calls are dropped", () => {
    const store = new ActivityStore();
    for (let index = 0; index < 60; index++) {
      const id = `d3d3d3d3-0000-4000-8000-${String(index).padStart(12, "0")}`;
      store.apply(event({ turnId: id }));
      store.end(id, "completed");
    }
    expect(store.turnIds().length).toBeLessThanOrEqual(30);
    for (let index = 0; index < 100; index++) store.apply(event({ executionId: `x${index}`, phase: "succeeded" }));
    expect(store.turn(turnId)?.executions.length).toBeLessThanOrEqual(40);
  });
});
