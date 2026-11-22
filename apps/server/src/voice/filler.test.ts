import { describe, expect, it } from "vitest";
import { isFillerTranscript, isStockPhrase } from "./filler.js";

describe("isFillerTranscript", () => {
  it("treats silence, stock phrases and filler sounds as no request", () => {
    for (const text of ["", "  ", "¡Gracias por ver el video!", "Subtítulos realizados por la comunidad de Amara.org", "Mmm, ajá", "Eh... este"]) {
      expect(isFillerTranscript(text), text).toBe(true);
    }
  });

  it("keeps anything that can answer or ask", () => {
    for (const text of ["sí", "dale", "Gracias.", "no, pará", "y mañana?", "mandale a Ana"]) {
      expect(isFillerTranscript(text), text).toBe(false);
    }
  });
});

describe("isStockPhrase", () => {
  it("matches whole invented credits, never words that contain them", () => {
    expect(isStockPhrase("Subtítulos realizados por la comunidad de Amara.org")).toBe(true);
    expect(isStockPhrase("gracias")).toBe(false);
    expect(isStockPhrase("prendé la cámara del living")).toBe(false);
    expect(isStockPhrase("llamá a Samara")).toBe(false);
    expect(isStockPhrase("anotá que la cámara org del club se reúne el martes y que gracias por ver lo del viernes no hace falta")).toBe(false);
  });
});
