export interface AuthState {
  authenticated: boolean;
  displayName?: string;
}

export type LoginOutcome = { ok: true; displayName: string | undefined } | { ok: false; message: string };

/** The server's answer, or null when it could not be reached (which says nothing about the login). */
export async function fetchAuthState(): Promise<AuthState | null> {
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (response.status === 401) return { authenticated: false };
    if (!response.ok) return null;
    return (await response.json()) as AuthState;
  } catch {
    return null;
  }
}

export function loginMessage(status: number): string {
  if (status === 401) return "Contraseña incorrecta.";
  if (status === 429) return "Demasiados intentos. Esperá unos minutos y probá de nuevo.";
  if (status === 403) return "Este sitio no está autorizado para iniciar sesión.";
  return "No pude iniciar sesión. Probá de nuevo.";
}

export async function login(password: string): Promise<LoginOutcome> {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) return { ok: false, message: loginMessage(response.status) };
    const body = (await response.json()) as AuthState;
    return { ok: true, displayName: body.displayName };
  } catch {
    return { ok: false, message: "No hay conexión con el servidor." };
  }
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}
