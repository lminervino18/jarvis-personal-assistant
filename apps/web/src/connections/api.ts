import type { Card } from "@jarvis/contracts";

export interface ConnectionsState {
  whatsapp: { status: string; detail: string; account: { number: string; name?: string } | null; pairing: Card | null } | null;
  gmail: { available: boolean; accounts: { label: string; email: string; status: string; drive: boolean }[] };
  github: { available: boolean; account: string | null };
}

/** Where the owner starts Google's authorization for one Gmail label. */
export const gmailConnectUrl = (label: "personal" | "work") => `/api/integrations/google/start?label=${label}`;

/** Where the owner starts GitHub's authorization; the server redirects there and back. */
export const GITHUB_CONNECT_URL = "/api/integrations/github/start";

export async function fetchConnections(): Promise<ConnectionsState | null> {
  try {
    const response = await fetch("/api/connections", { credentials: "same-origin" });
    return response.ok ? ((await response.json()) as ConnectionsState) : null;
  } catch {
    return null;
  }
}

/** Asks the stopped WhatsApp bridge to connect again: a fresh QR when it has to be linked. Answers whether it was asked. */
export async function wakeWhatsApp(): Promise<boolean> {
  const response = await fetch("/api/connections/whatsapp/wake", { method: "POST", credentials: "same-origin" }).catch(() => null);
  return response?.ok === true;
}

/** Disconnects a service; a Gmail account is revoked at Google too. Answers whether it worked. */
export async function disconnect(provider: "github" | "gmail-personal" | "gmail-work"): Promise<boolean> {
  const gmail = provider.startsWith("gmail-");
  const url = gmail ? "/api/integrations/google/revoke" : `/api/integrations/${provider}/disconnect`;
  const body = gmail ? { body: JSON.stringify({ label: provider.slice("gmail-".length) }), headers: { "Content-Type": "application/json" } } : {};
  const response = await fetch(url, { method: "POST", credentials: "same-origin", ...body }).catch(() => null);
  return response?.ok === true;
}
