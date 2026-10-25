import { describe, expect, it } from "vitest";
import { integrationResultCard, parseIntegrationResult } from "./integration-result.js";

describe("Gmail connection result", () => {
  it("reads a successful connection", () => {
    expect(parseIntegrationResult("?integration=gmail&status=connected&label=work")).toEqual({ status: "connected", label: "work", reason: null });
    expect(integrationResultCard({ status: "connected", label: "work", reason: null })).toMatchObject({
      kind: "integration",
      provider: "gmail",
      status: "connected",
      message: "Gmail (de trabajo) quedó conectado.",
    });
  });

  it("explains each failure in Spanish and offers a retry for a known label", () => {
    const result = parseIntegrationResult("?integration=gmail&status=error&label=personal&reason=denied");
    const card = integrationResultCard(result!);
    expect(card).toMatchObject({ status: "error", actionUrl: "/api/integrations/google/start?label=personal", actionLabel: "Reintentar" });
    expect(card.kind === "integration" && card.message).toContain("Cancelaste");
    const unknown = integrationResultCard({ status: "error", label: null, reason: "something_new" });
    expect(unknown).toMatchObject({ message: "No pude conectar Gmail." });
    expect(unknown).not.toHaveProperty("actionUrl");
  });

  it("ignores other integrations, unknown statuses and unknown labels", () => {
    expect(parseIntegrationResult("")).toBeNull();
    expect(parseIntegrationResult("?demo")).toBeNull();
    expect(parseIntegrationResult("?integration=whatsapp&status=connected")).toBeNull();
    expect(parseIntegrationResult("?integration=gmail&status=hacked")).toBeNull();
    expect(parseIntegrationResult("?integration=gmail&status=connected&label=../../x")?.label).toBeNull();
  });
});
