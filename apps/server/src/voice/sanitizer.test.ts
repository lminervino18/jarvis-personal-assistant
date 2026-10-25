import { describe, expect, it } from "vitest";
import { sanitizeForSpeech } from "./sanitizer.js";

describe("sanitizeForSpeech", () => {
  it("strips markdown emphasis, headings, quotes and list markers", () => {
    expect(sanitizeForSpeech("## Agenda\n**Hoy** tenés _tres_ cosas")).toBe("Agenda. Hoy tenés tres cosas");
    expect(sanitizeForSpeech("- primero\n* segundo\n3. tercero")).toBe("primero. segundo. tercero");
    expect(sanitizeForSpeech("> cita importante")).toBe("cita importante");
  });

  it("keeps link text and replaces bare URLs", () => {
    expect(sanitizeForSpeech("Mirá [la nota](https://example.com/a?b=1) ahora")).toBe("Mirá la nota ahora");
    expect(sanitizeForSpeech("Entrá a https://example.com/x/y?z=1 y listo")).toBe("Entrá a el enlace y listo");
    expect(sanitizeForSpeech("Está en www.example.com.")).toBe("Está en el enlace.");
  });

  it("drops code blocks and keeps inline code words", () => {
    expect(sanitizeForSpeech("Corré ```npm test``` ahora")).toBe("Corré ahora");
    expect(sanitizeForSpeech("Abrí `config` y revisá")).toBe("Abrí config y revisá");
  });

  it("removes emojis, flags, skin tones and variation selectors", () => {
    expect(sanitizeForSpeech("Listo 🎉👍🏽 nos vemos ❤️ 🇦🇷")).toBe("Listo nos vemos");
    expect(sanitizeForSpeech("😀")).toBe("");
  });

  it("pronounces J.A.R.V.I.S as Jarvis in its spellings", () => {
    expect(sanitizeForSpeech("Soy J.A.R.V.IS.")).toBe("Soy Jarvis.");
    expect(sanitizeForSpeech("Soy J.A.R.V.I.S, tu asistente")).toBe("Soy Jarvis, tu asistente");
    expect(sanitizeForSpeech("JARVIS al habla")).toBe("Jarvis al habla");
  });

  it("speaks symbols and tables sensibly", () => {
    expect(sanitizeForSpeech("Subió 20% & bajó")).toBe("Subió 20 por ciento y bajó");
    expect(sanitizeForSpeech("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a, b. 1, 2");
    expect(sanitizeForSpeech("Madrid -> Buenos Aires")).toBe("Madrid, Buenos Aires");
  });

  it("keeps decimals, times and accents untouched", () => {
    expect(sanitizeForSpeech("Son las 20.30, ¿viste 3,5 km?")).toBe("Son las 20.30, ¿viste 3,5 km?");
  });
});
