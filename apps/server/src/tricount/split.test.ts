import { describe, expect, it } from "vitest";
import { apportion, balances, formatSplit, pesos, settle } from "./split.js";

describe("the Tricount engine", () => {
  it("splits in whole cents that always add up", () => {
    expect(apportion(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(apportion(1001, [2, 1])).toEqual([667, 334]);
    expect(apportion(5, [1, 1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });

  it("charges each expense only to who consumed it, by weight, and counts later payments", () => {
    const people = ["Loren", "Pavón", "Gero", "Flor"];
    const balance = balances(
      people,
      [
        { concept: "Carne", amount: 40_000, paidBy: "Pavón" },
        { concept: "Vino", amount: 9_000, paidBy: "Loren", participants: ["Loren", "Pavón", "Gero"] },
        { concept: "Helado", amount: 3_000, paidBy: "loren", participants: ["Gero", "Flor"], shares: { Gero: 2 } },
      ],
      [{ from: "Flor", to: "Pavón", amount: 5_000 }],
    );
    expect(Object.fromEntries(balance)).toEqual({ Loren: -100_000, Pavón: 2_200_000, Gero: -1_500_000, Flor: -600_000 });
    expect([...balance.values()].reduce((sum, cents) => sum + cents, 0)).toBe(0);
  });

  it("settles with at most people minus one transfers, always the same way", () => {
    const people = ["Flor", "Gero", "Lucas", "Pavón", "Loren"];
    const balance = new Map([
      ["Flor", -1_349_500],
      ["Gero", -2_516_100],
      ["Lucas", -2_516_100],
      ["Pavón", 4_131_200],
      ["Loren", 2_250_500],
    ]);
    const transfers = settle(people, balance);
    expect(transfers.length).toBeLessThanOrEqual(people.length - 1);
    expect(settle(people, balance)).toEqual(transfers);
    const after = new Map(balance);
    for (const transfer of transfers) {
      after.set(transfer.from, (after.get(transfer.from) ?? 0) + transfer.cents);
      after.set(transfer.to, (after.get(transfer.to) ?? 0) - transfer.cents);
    }
    expect([...after.values()].every((cents) => cents === 0)).toBe(true);
  });

  it("answers in the owner's exact format, and says which aliases are missing", () => {
    const people = ["Flor", "Gero", "Pavón", "Loren"];
    const transfers = [
      { from: "Gero", to: "Loren", cents: 1_217_900 },
      { from: "Flor", to: "Pavón", cents: 1_349_500 },
      { from: "Gero", to: "Pavón", cents: 1_298_200 },
    ];
    const known = formatSplit(people, transfers, new Map([["pavón", "ILOGIK"], ["loren", "lminervino18"]]));
    expect(known.text).toBe("Flor → Pavón: $13.495\nGero → Pavón: $12.982\n\nGero → Loren: $12.179\n\nAlias Pavón: ILOGIK\nAlias Loren: lminervino18");
    expect(known.missingAliases).toEqual([]);
    expect(formatSplit(people, transfers, new Map([["loren", "lminervino18"]])).missingAliases).toEqual(["Pavón"]);
    expect(pesos(73_550)).toBe("$735,50");
    expect(formatSplit(people, [], new Map()).text).toContain("a mano");
  });
});
