import type { Card } from "@jarvis/contracts";

export interface IntegrationResult {
  status: "connected" | "error";
  label: "personal" | "work" | null;
  reason: string | null;
}

const labelNames = { personal: "personal", work: "de trabajo" } as const;

const reasonMessages: Record<string, string> = {
  denied: "Cancelaste la autorización de Google. Podés reintentar cuando quieras.",
  invalid_state: "El enlace de conexión venció. Probá de nuevo.",
  scope_missing: "Faltó aceptar el permiso de lectura de Gmail. Probá de nuevo y aceptá todos los permisos.",
  no_refresh_token: "Google no entregó la autorización permanente. Quitá el acceso desde tu cuenta de Google y probá de nuevo.",
  identity_rejected: "No pude verificar la cuenta de Google.",
  label_bound: "Esa etiqueta ya tiene otra cuenta de Gmail conectada.",
  email_bound: "Esa cuenta de Gmail ya está conectada con otra etiqueta.",
  unavailable: "Google no está disponible ahora. Probá más tarde.",
};

/** Reads the redirect the Gmail connector sends the browser back with. Anything else returns null. */
export function parseIntegrationResult(search: string): IntegrationResult | null {
  const params = new URLSearchParams(search);
  if (params.get("integration") !== "gmail") return null;
  const status = params.get("status");
  if (status !== "connected" && status !== "error") return null;
  const label = params.get("label");
  return {
    status,
    label: label === "personal" || label === "work" ? label : null,
    reason: params.get("reason"),
  };
}

export function integrationResultCard(result: IntegrationResult): Card {
  const name = result.label ? `Gmail (${labelNames[result.label]})` : "Gmail";
  if (result.status === "connected") {
    return { kind: "integration", provider: "gmail", status: "connected", message: `${name} quedó conectado.` };
  }
  const message = reasonMessages[result.reason ?? ""] ?? `No pude conectar ${name}.`;
  return {
    kind: "integration",
    provider: "gmail",
    status: "error",
    message,
    ...(result.label ? { actionUrl: `/api/integrations/google/start?label=${result.label}`, actionLabel: "Reintentar" } : {}),
  };
}
