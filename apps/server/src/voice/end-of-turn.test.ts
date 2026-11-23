import { describe, expect, it } from "vitest";
import { turnLooksComplete } from "./end-of-turn.js";
import { isBackchannel } from "./filler.js";

describe("end of turn", () => {
  it("closes quickly on questions, short answers and finished sentences", () => {
    for (const text of ["¿Qué hora es?", "Sí.", "Dale", "No, gracias.", "Mandale un WhatsApp a Juan diciendo que llego tarde.", "Buscá el del viernes."]) {
      expect(turnLooksComplete(text), text).toBe(true);
    }
  });

  it("keeps the turn open when the words hang on a connector, an ellipsis or a self-correction", () => {
    for (const text of ["Quiero que...", "Quiero que", "Buscá el de mañana…", "Buscá el de mañana, perdón", "Mandale a", "Necesito", "Revisá el correo y", "Eh", "o sea", ""]) {
      expect(turnLooksComplete(text), text).toBe(false);
    }
  });

  it("treats short acknowledgements during the reply as backchannel, not as a new turn", () => {
    for (const text of ["Ajá.", "Sí, claro.", "Dale.", "Mhm", "Ok"]) expect(isBackchannel(text), text).toBe(true);
    for (const text of ["Pará.", "Callate", "Esperá, no.", "No, el del viernes", "Sí, pero mandalo mañana"]) expect(isBackchannel(text), text).toBe(false);
  });
});
