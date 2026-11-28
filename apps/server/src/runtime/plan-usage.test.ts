import { describe, expect, it } from "vitest";
import { PlanUsageReader, usageFromHeaders } from "./plan-usage.js";

const headers = (status = "allowed") =>
  new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.45",
    "anthropic-ratelimit-unified-5h-reset": "1795858800",
    "anthropic-ratelimit-unified-7d-utilization": "0.74",
    "anthropic-ratelimit-unified-7d-reset": "1796018400",
    "anthropic-ratelimit-unified-status": status,
  });

describe("plan usage", () => {
  it("reads the 5-hour and weekly windows from the rate-limit headers", () => {
    const now = new Date("2026-11-28T06:30:00Z");
    expect(usageFromHeaders(headers(), now)).toEqual({
      session: { utilization: 0.45, resetsAt: "2026-11-28T09:40:00.000Z" },
      week: { utilization: 0.74, resetsAt: "2026-11-30T06:00:00.000Z" },
      allowed: true,
      checkedAt: "2026-11-28T06:30:00.000Z",
    });
    expect(usageFromHeaders(headers("rejected"), now)?.allowed).toBe(false);
    expect(usageFromHeaders(new Headers(), now)).toBeUndefined();
  });

  it("asks Haiku for one token, sends the token only to Anthropic, and caches for two minutes", async () => {
    const calls: { url: string; body: { model: string; max_tokens: number } }[] = [];
    let now = new Date("2026-11-28T06:30:00Z");
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { headers: headers() });
    }) as unknown as typeof fetch;
    const reader = new PlanUsageReader("sk-test", fetchFn, () => now);
    expect((await reader.read())?.week.utilization).toBe(0.74);
    await reader.read();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages", body: { model: "claude-haiku-4-5", max_tokens: 1 } });
    now = new Date(now.getTime() + 3 * 60_000);
    await reader.read();
    expect(calls).toHaveLength(2);
  });

  it("answers nothing when Anthropic cannot be reached", async () => {
    const reader = new PlanUsageReader("sk-test", (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    expect(await reader.read()).toBeUndefined();
  });
});
