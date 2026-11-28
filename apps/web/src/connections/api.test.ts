import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeWhatsApp } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connections api", () => {
  it("asks the WhatsApp bridge to connect again and says whether the server took it", async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return Response.json({ ok: true });
    });
    expect(await wakeWhatsApp()).toBe(true);
    expect(calls).toEqual([{ url: "/api/connections/whatsapp/wake", method: "POST" }]);
    let body: unknown;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), Response.json({ ok: true })));
    expect(await wakeWhatsApp("+54 9 11 0000-0000")).toBe(true);
    expect(body).toEqual({ phone: "+54 9 11 0000-0000" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await wakeWhatsApp()).toBe(false);
  });
});
