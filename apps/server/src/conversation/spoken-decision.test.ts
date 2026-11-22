import { describe, expect, it } from "vitest";
import { confirmQuestion, spokenDecision } from "./spoken-decision.js";

describe("spokenDecision", () => {
  it("accepts short yes answers in rioplatense", () => {
    for (const text of ["Sí.", "dale", "Sí, mandalo", "de una, Jarvis", "ok confirmo", "Dale, por favor!"]) expect(spokenDecision(text)).toBe("confirm");
  });

  it("accepts short no answers", () => {
    for (const text of ["No.", "no, mejor no", "cancelalo", "no gracias"]) expect(spokenDecision(text)).toBe("reject");
  });

  it("treats anything longer or mixed as a normal turn", () => {
    for (const text of ["", "sí pero cambiá el texto", "gracias", "mejor", "dale y después decime el clima", "sí no sé"]) expect(spokenDecision(text)).toBeUndefined();
  });
});

describe("confirmQuestion", () => {
  it("reads the card itself, not the model's words", () => {
    const question = confirmQuestion({
      kind: "confirm",
      actionId: "a1",
      title: "Enviar WhatsApp",
      summary: "Para Ana Vivo",
      details: [{ label: "Mensaje", value: "llego en 10." }],
      expiresAt: "2026-11-21T12:00:00.000Z",
      status: "pending",
    });
    expect(question).toBe("Enviar WhatsApp. Para Ana Vivo. Mensaje: llego en 10. ¿Confirmo?");
  });
});
