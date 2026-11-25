import { z } from "zod";

const API = "https://api.vercel.com";
const REQUEST_TIMEOUT_MS = 30_000;

export type VercelFailure = "unauthorized" | "not_found" | "conflict" | "rejected" | "unavailable";

/** A failed Vercel call. The message never carries tokens or response bodies. */
export class VercelError extends Error {
  constructor(
    readonly reason: VercelFailure,
    readonly status?: number,
  ) {
    super(`vercel ${reason}${status ? ` (${status})` : ""}`);
  }
}

const User = z.object({ user: z.object({ username: z.string().min(1) }) });
const Teams = z.object({ teams: z.array(z.object({ id: z.string(), slug: z.string() })) });

function failure(status: number): VercelFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/** The Vercel REST calls JARVIS needs to publish projects, over `fetch`. */
export class VercelClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async user(token: string): Promise<string> {
    return User.parse(await this.api(token, "GET", "/v2/user")).user.username;
  }

  /** The team that owns `domain`, so projects can use its subdomains; undefined when no team has it. */
  async teamForDomain(token: string, domain: string): Promise<string | undefined> {
    const { teams } = Teams.parse(await this.api(token, "GET", "/v2/teams"));
    for (const team of teams) {
      try {
        await this.api(token, "GET", `/v6/domains/${encodeURIComponent(domain)}?teamId=${team.id}`);
        return team.id;
      } catch (error) {
        if (!(error instanceof VercelError) || error.reason !== "not_found") throw error;
      }
    }
    return undefined;
  }

  private async api(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
        ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VercelError("unavailable");
    }
    if (!response.ok) throw new VercelError(failure(response.status), response.status);
    return response.json();
  }
}
