import type { Card } from "@jarvis/contracts";

export interface IntegrationResult {
  provider: "gmail" | "github";
  status: "connected" | "error";
  /** The Gmail label (personal or work), or the GitHub login. */
  label: string | null;
  reason: string | null;
}

const labelNames: Record<string, string> = { personal: "personal", work: "de trabajo" };
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const githubReasons: Record<string, string> = {
  denied: "Cancelaste la autorización de GitHub. Podés reintentar cuando quieras.",
  invalid_state: "El enlace de conexión venció. Probá de nuevo.",
};

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

/** Reads the redirect the Gmail or GitHub connector sends the browser back with. Anything else returns null. */
export function parseIntegrationResult(search: string): IntegrationResult | null {
  const params = new URLSearchParams(search);
  const provider = params.get("integration");
  if (provider !== "gmail" && provider !== "github") return null;
  const status = params.get("status");
  if (status !== "connected" && status !== "error") return null;
  const label = params.get("label") ?? "";
  const valid = provider === "gmail" ? label in labelNames : GITHUB_LOGIN.test(label);
  return { provider, status, label: valid ? label : null, reason: params.get("reason") };
}

function githubCard(result: IntegrationResult): Card {
  if (result.status === "connected") {
    return { kind: "integration", provider: "github", status: "connected", message: result.label ? `GitHub quedó conectado como ${result.label}.` : "GitHub quedó conectado." };
  }
  const message = githubReasons[result.reason ?? ""] ?? "No pude conectar GitHub. Probá de nuevo en un rato.";
  return { kind: "integration", provider: "github", status: "error", message, actionUrl: "/api/integrations/github/start", actionLabel: "Reintentar" };
}

export function integrationResultCard(result: IntegrationResult): Card {
  if (result.provider === "github") return githubCard(result);
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
