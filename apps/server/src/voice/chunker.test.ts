import { describe, expect, it } from "vitest";
import { SentenceChunker } from "./chunker.js";

function chunk(text: string, step = text.length): string[] {
  const chunker = new SentenceChunker();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(...chunker.push(text.slice(i, i + step)));
  out.push(...chunker.flush());
  return out;
}

describe("SentenceChunker", () => {
  it("splits sentences and keeps Spanish question and exclamation marks", () => {
    expect(chunk("Hola Loren, buen día. ¿Cómo dormiste? ¡Espero que bien!")).toEqual([
      "Hola Loren, buen día.",
      "¿Cómo dormiste?",
      "¡Espero que bien!",
    ]);
  });

  it("gives the same chunks however the stream is sliced", () => {
    const text = "Tenés reunión con la Dra. Pérez a las 20.30. Son 3.5 km, más o menos. Dale, nos vemos.";
    const expected = chunk(text);
    for (const step of [1, 2, 3, 7, 13]) expect(chunk(text, step)).toEqual(expected);
  });

  it("does not split on abbreviations, decimals, times or initials", () => {
    expect(chunk("El Sr. García llegó. Costó 3.5 dólares aprox. y salió a las 20.30 hs.")).toEqual([
      "El Sr. García llegó.",
      "Costó 3.5 dólares aprox. y salió a las 20.30 hs.",
    ]);
    expect(chunk("Habló Tony S. Stark con Pepper. Listo.")).toEqual(["Habló Tony S. Stark con Pepper.", "Listo."]);
  });

  it("splits after etc. only when a new sentence starts", () => {
    expect(chunk("Compré pan, leche, etc. Después volví a casa.")).toEqual(["Compré pan, leche, etc.", "Después volví a casa."]);
    expect(chunk("Compré pan, leche, etc. y volví a casa.")).toEqual(["Compré pan, leche, etc. y volví a casa."]);
  });

  it("treats ellipses as a pause unless a new sentence follows", () => {
    expect(chunk("Mmm... creo que sí, pero no estoy seguro.")).toEqual(["Mmm... creo que sí, pero no estoy seguro."]);
    expect(chunk("Mmm, bueno... Ahora sí te cuento todo.")).toEqual(["Mmm, bueno...", "Ahora sí te cuento todo."]);
  });

  it("keeps closing quotes and parentheses with their sentence", () => {
    expect(chunk('Dijo "ya voy." Y se fue (rápido). Chau.')).toEqual(['Dijo "ya voy."', "Y se fue (rápido).", "Chau."]);
  });

  it("splits list items on line breaks and does not treat list numbers as sentences", () => {
    expect(chunk("Tenés:\n1. Reunión con Ana\n2. Almuerzo con Pedro\n- Gimnasio a las 19")).toEqual([
      "Tenés: 1. Reunión con Ana",
      "2. Almuerzo con Pedro",
      "- Gimnasio a las 19",
    ]);
  });

  it("merges chunks shorter than the minimum into the next one", () => {
    expect(chunk("Sí. Ya lo anoté en tu agenda.")).toEqual(["Sí. Ya lo anoté en tu agenda."]);
    expect(chunk("Listo.")).toEqual(["Listo."]);
  });

  it("flushes the first chunk early at a comma when the sentence runs long", () => {
    const chunker = new SentenceChunker();
    const first = chunker.push("Mirá, hoy tenés bastante trabajo por delante porque se juntaron varias reuniones y entregas, ");
    expect(first).toEqual(["Mirá, hoy tenés bastante trabajo por delante porque se juntaron varias reuniones y entregas,"]);
    expect(chunker.push("pero se puede ordenar bien.")).toEqual([]);
    expect(chunker.flush()).toEqual(["pero se puede ordenar bien."]);
  });

  it("does not flush early at decimal commas", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("El resultado fue de 3,5 puntos sobre el total que habíamos calculado la semana pasada ")).toEqual([]);
  });

  it("drops fenced code even when the fence markers are split across deltas", () => {
    expect(chunk("Probá esto:\n```ts\nconst a = 1;\n```\nY avisame si falla.", 3)).toEqual(["Probá esto:", "Y avisame si falla."]);
  });

  it("discards an unterminated fence and reset() drops pending text", () => {
    const chunker = new SentenceChunker();
    chunker.push("Texto provisional sin cerrar");
    chunker.reset();
    expect(chunker.flush()).toEqual([]);
    expect(chunk("Mirá:\n```\nsin cierre")).toEqual(["Mirá:"]);
  });
});
