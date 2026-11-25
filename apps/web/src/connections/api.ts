export interface ConnectionsState {
  gmail: { available: boolean; accounts: { label: string; email: string; status: string }[] };
  github: { available: boolean; account: string | null };
  vercel: { available: boolean; account: string | null; domain: string | null };
}

export type SaveOutcome = { ok: true } | { ok: false; message: string };

/** Where the owner starts Google's authorization for one Gmail label. */
export const gmailConnectUrl = (label: "personal" | "work") => `/api/integrations/google/start?label=${label}`;

/** Where the owner starts GitHub's authorization; the server redirects there and back. */
export const GITHUB_CONNECT_URL = "/api/integrations/github/start";
/** Vercel's page for creating the token the owner pastes. */
export const VERCEL_TOKENS_URL = "https://vercel.com/account/settings/tokens";

export async function fetchConnections(): Promise<ConnectionsState | null> {
  try {
    const response = await fetch("/api/connections", { credentials: "same-origin" });
    return response.ok ? ((await response.json()) as ConnectionsState) : null;
  } catch {
    return null;
  }
}

export async function saveVercelToken(token: string): Promise<SaveOutcome> {
  try {
    const response = await fetch("/api/integrations/vercel/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: response.status === 400 ? "Vercel no aceptó ese token." : "No pude hablar con Vercel. Probá de nuevo." };
  } catch {
    return { ok: false, message: "No hay conexión con el servidor." };
  }
}

export async function disconnect(provider: "github" | "vercel"): Promise<void> {
  await fetch(`/api/integrations/${provider}/disconnect`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}
