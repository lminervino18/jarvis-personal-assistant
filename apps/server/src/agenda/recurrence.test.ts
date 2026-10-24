import { describe, expect, it } from "vitest";
import { RecurrenceError, anchoredRule, nextOccurrence, normalizeRule, occurrencesBetween } from "./recurrence.js";

const BA = "America/Argentina/Buenos_Aires";

describe("recurrence", () => {
  it("expands a daily rule at the same local time in a zone without DST", () => {
    const series = { startUtc: "2026-10-24T12:00:00.000Z", timezone: BA, rule: "FREQ=DAILY" };
    expect(occurrencesBetween(series, "2026-10-25T00:00:00.000Z", "2026-10-27T23:59:59.000Z", 10)).toEqual([
      "2026-10-25T12:00:00.000Z",
      "2026-10-26T12:00:00.000Z",
      "2026-10-27T12:00:00.000Z",
    ]);
  });

  it("keeps the local wall-clock time across a DST change", () => {
    const series = { startUtc: "2026-03-07T14:00:00.000Z", timezone: "America/New_York", rule: "FREQ=DAILY" };
    expect(occurrencesBetween(series, "2026-03-07T00:00:00.000Z", "2026-03-09T23:00:00.000Z", 10)).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  it("uses local weekdays for weekly rules, not UTC weekdays", () => {
    const series = { startUtc: "2026-10-29T01:30:00.000Z", timezone: BA, rule: "FREQ=WEEKLY;BYDAY=WE,FR" };
    expect(occurrencesBetween(series, "2026-10-28T00:00:00.000Z", "2026-11-05T02:00:00.000Z", 10)).toEqual([
      "2026-10-29T01:30:00.000Z",
      "2026-10-31T01:30:00.000Z",
      "2026-11-05T01:30:00.000Z",
    ]);
  });

  it("skips months without the start day and leap days on other years", () => {
    const monthly = { startUtc: "2026-01-31T12:00:00.000Z", timezone: BA, rule: "FREQ=MONTHLY" };
    expect(occurrencesBetween(monthly, "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", 10)).toEqual([
      "2026-01-31T12:00:00.000Z",
      "2026-03-31T12:00:00.000Z",
      "2026-05-31T12:00:00.000Z",
    ]);
    const leap = { startUtc: "2028-02-29T12:00:00.000Z", timezone: BA, rule: "FREQ=YEARLY" };
    expect(nextOccurrence(leap, "2028-03-01T00:00:00.000Z")).toBe("2032-02-29T12:00:00.000Z");
  });

  it("anchors COUNT as UNTIL so the series can advance without changing its meaning", () => {
    const series = { startUtc: "2026-10-24T12:00:00.000Z", timezone: BA, rule: "FREQ=DAILY;COUNT=3" };
    const rule = anchoredRule(series);
    expect(rule).toBe("FREQ=DAILY;UNTIL=20261026T120000Z");
    const advanced = { ...series, startUtc: "2026-10-25T12:00:00.000Z", rule };
    expect(nextOccurrence(advanced, "2026-10-25T12:00:00.001Z")).toBe("2026-10-26T12:00:00.000Z");
    expect(nextOccurrence(advanced, "2026-10-26T12:00:00.001Z")).toBeUndefined();
  });

  it("reads a date-only UNTIL as the end of that day in the series zone", () => {
    const series = { startUtc: "2026-10-30T23:30:00.000Z", timezone: BA, rule: "FREQ=DAILY;UNTIL=20261031" };
    expect(occurrencesBetween(series, "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", 10)).toEqual([
      "2026-10-30T23:30:00.000Z",
      "2026-10-31T23:30:00.000Z",
    ]);
  });

  it("normalizes supported rules and rejects the rest", () => {
    expect(normalizeRule("rrule:freq=weekly;interval=1;byday=fr,mo", BA)).toBe("FREQ=WEEKLY;BYDAY=MO,FR");
    for (const rule of ["FREQ=HOURLY", "FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYMONTHDAY=5", "FREQ=DAILY;COUNT=2;UNTIL=20261030", "FREQ=DAILY;INTERVAL=0"]) {
      expect(() => normalizeRule(rule, BA)).toThrow(RecurrenceError);
    }
  });
});
