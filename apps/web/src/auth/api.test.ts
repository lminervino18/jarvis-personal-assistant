import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAuthState, loginMessage } from "./api.js";

function stubFetch(result: Response | Error): void {
  vi.stubGlobal("fetch", async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth api", () => {
  it("reads the session and treats 401 as logged out", async () => {
    stubFetch(Response.json({ authenticated: true, displayName: "Test" }));
    expect(await fetchAuthState()).toEqual({ authenticated: true, displayName: "Test" });
    stubFetch(new Response("{}", { status: 401 }));
    expect(await fetchAuthState()).toEqual({ authenticated: false });
  });

  it("does not mistake an unreachable or failing server for a logged out owner", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    expect(await fetchAuthState()).toBeNull();
    stubFetch(new Response("boom", { status: 502 }));
    expect(await fetchAuthState()).toBeNull();
  });

  it("explains login failures in Spanish", () => {
    expect(loginMessage(401)).toContain("incorrecta");
    expect(loginMessage(429)).toContain("intentos");
    expect(loginMessage(500)).toContain("No pude");
  });
});
