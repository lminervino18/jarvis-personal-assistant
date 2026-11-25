import { describe, expect, it } from "vitest";
import { integrationResultCard, parseIntegrationResult } from "./integration-result.js";

describe("Gmail connection result", () => {
  it("reads a successful connection", () => {
    expect(parseIntegrationResult("?integration=gmail&status=connected&label=work")).toEqual({ provider: "gmail", status: "connected", label: "work", reason: null });
    expect(integrationResultCard({ provider: "gmail", status: "connected", label: "work", reason: null })).toMatchObject({
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
    const unknown = integrationResultCard({ provider: "gmail", status: "error", label: null, reason: "something_new" });
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

describe("GitHub connection result", () => {
  it("names the connected login and offers a retry after a failure", () => {
    const connected = parseIntegrationResult("?integration=github&status=connected&label=owner-login");
    expect(integrationResultCard(connected!)).toMatchObject({ provider: "github", status: "connected", message: "GitHub quedó conectado como owner-login." });
    const failed = integrationResultCard(parseIntegrationResult("?integration=github&status=error&reason=denied")!);
    expect(failed).toMatchObject({ status: "error", actionUrl: "/api/integrations/github/start" });
    expect(parseIntegrationResult("?integration=github&status=connected&label=<b>x</b>")?.label).toBeNull();
  });
});
