import { describe, expect, it } from "vitest";
import { formatDateTime, formatDay, formatTime, safeHref } from "./format.js";

describe("dates in the owner's time zone", () => {
  it("formats UTC instants as Buenos Aires time", () => {
    expect(formatTime("2026-10-24T17:30:00.000Z")).toBe("14:30");
    expect(formatTime("2026-10-24T17:30:00.000Z", "Europe/Madrid")).toBe("19:30");
  });

  it("falls back to Buenos Aires for an unknown zone", () => {
    expect(formatTime("2026-10-24T17:30:00.000Z", "Not/AZone")).toBe("14:30");
  });

  it("includes weekday, day and time", () => {
    const text = formatDateTime("2026-10-24T17:30:00.000Z");
    expect(text).toContain("24");
    expect(text).toContain("14:30");
  });

  it("labels today and yesterday by the owner's calendar day", () => {
    const now = new Date("2026-10-25T01:30:00.000Z");
    expect(formatDay("2026-10-25T00:10:00.000Z", now)).toBe("Hoy");
    expect(formatDay("2026-10-24T12:00:00.000Z", now)).toBe("Hoy");
    expect(formatDay("2026-10-23T12:00:00.000Z", now)).toBe("Ayer");
    expect(formatDay("2026-10-20T12:00:00.000Z", now)).toContain("20");
  });
});

describe("safeHref", () => {
  it("allows web links and same-site paths only", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("/api/oauth/start")).toBe("/api/oauth/start");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});
