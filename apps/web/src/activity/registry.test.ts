import { toolNames } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { externalPresentations, failureLabel, integrations, presentTool, sanitizeToolName, toolPresentations } from "./registry.js";

const logoFiles = Object.keys(import.meta.glob("/public/logos/*.png", { query: "?url", eager: false }));

describe("tool presentation registry", () => {
  it("has an entry for every tool the assistant owns", () => {
    const missing = toolNames.filter((name) => !toolPresentations[name]);
    expect(missing).toEqual([]);
  });

  it("has no entry for a tool that does not exist", () => {
    expect(Object.keys(toolPresentations).filter((name) => !(toolNames as string[]).includes(name))).toEqual([]);
  });

  it("points every entry at a known integration and writes its texts as live and finished", () => {
    for (const entry of [...Object.values(toolPresentations), ...Object.values(externalPresentations)]) {
      expect(integrations[entry.integration]).toBeDefined();
      expect(entry.running.endsWith("…")).toBe(true);
      expect(entry.done.endsWith("…")).toBe(false);
      expect(entry.running.length).toBeLessThanOrEqual(45);
    }
  });

  it("uses only logos that exist in the app", () => {
    for (const integration of Object.values(integrations)) {
      if (integration.visual.kind === "logo") expect(logoFiles).toContain(`/public/logos/${integration.visual.name}.png`);
    }
  });

  it("describes the real action, so a search is not presented as opening", () => {
    expect(presentTool("youtube_search").running).toBe("Buscando en YouTube…");
    expect(presentTool("youtube_open").running).toBe("Abriendo YouTube…");
    expect(presentTool("WebSearch")).toMatchObject({ known: true, integration: "web" });
  });

  it("gives an unknown tool a generic icon and a sanitized name, never markup", () => {
    const unknown = presentTool("mcp__other__<img src=x onerror=alert(1)>_scan");
    expect(unknown).toMatchObject({ known: false, integration: "other" });
    expect(unknown.running).not.toMatch(/[<>=]/);
    expect(presentTool("")).toMatchObject({ known: false, running: "Procesando tu pedido…" });
    expect(sanitizeToolName("x".repeat(200)).length).toBeLessThanOrEqual(28);
  });

  it("maps error codes to a readable failure and falls back for a code it does not know", () => {
    const gmail = presentTool("gmail_search");
    expect(failureLabel(gmail, "auth_expired")).toBe("Hay que reconectar Gmail");
    expect(failureLabel(gmail, "something_new")).toBe("No se pudo completar con Gmail");
    expect(failureLabel(gmail, undefined)).toBe("No se pudo completar con Gmail");
  });
});
