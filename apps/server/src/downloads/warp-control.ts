/**
 * Asks the WARP supervisor to reconnect the tunnel (`restart`) or to register a new identity
 * (`renew`). Resolves true once the supervisor says the tunnel carries traffic again.
 */
export function warpHealer(base: string, fetchFn: typeof fetch = fetch, timeoutMs = 150_000): (how: "restart" | "renew") => Promise<boolean> {
  return async (how) => {
    try {
      const response = await fetchFn(`${base.replace(/\/+$/, "")}/${how}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  };
}
