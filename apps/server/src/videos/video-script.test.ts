import { VideoBrief } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { repetitionProblem } from "./video-script.js";

const brief = (purpose: string, scenes: object[]) => VideoBrief.parse({ title: "t", audience: "a", goal: "other", message: "m", purpose, scenes });

describe("video script repetition", () => {
  it("rejects a scene that says again what the intro already said", () => {
    const asado = brief("contarles que Loren la pasó muy bien en el asado y que después pasen cuentas", [
      { type: "title", title: "¡La pasé muy bien en el asado!", narration: "Loren la pasó muy bien en el asado." },
    ]);
    expect(repetitionProblem(asado, "Loren")).toContain("La escena 1 repite lo que ya dice la presentación");
    const question = brief("preguntarles cómo les fue en el relámpago", [
      { type: "question", question: "¿Cómo les fue en el relámpago?", options: [{ label: "Bien" }, { label: "Mal" }], narration: "Contale a Loren: bien o mal." },
    ]);
    expect(repetitionProblem(question, "Loren")).toContain("La escena 1 repite");
  });

  it("rejects a scene that repeats an earlier one", () => {
    const twice = brief("invitarte al asado del sábado", [
      { type: "title", title: "En casa a las 21", narration: "Es en casa a las veintiuna, traé bebida." },
      { type: "closing", title: "Te esperamos", action: "Respondé a este mensaje", narration: "En casa a las veintiuna, traé bebida." },
    ]);
    expect(repetitionProblem(twice, "Loren")).toContain("La escena 2 repite lo que dice la escena 1");
  });

  it("accepts scenes that add something new", () => {
    const fine = brief("invitarte al asado del sábado", [
      { type: "title", title: "En casa a las 21", narration: "Es en casa a las veintiuna, traé bebida." },
      { type: "question", question: "¿Venís?", options: [{ label: "Sí" }, { label: "No" }], narration: "¿Venís? Contestá sí o no." },
    ]);
    expect(repetitionProblem(fine, "Loren")).toBeUndefined();
    const demo = brief("mostrarte que ahora hago videos", [{ type: "title", title: "Videos cortos con mi voz", narration: "Pedímelos desde el chat y te los mando listos." }]);
    expect(repetitionProblem(demo, "Loren")).toBeUndefined();
  });
});
