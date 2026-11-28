import type { FastifyInstance } from "fastify";
import type { RouteHelpers } from "../app.js";

/** How much of one plan window is used (0 to 1) and when it starts over. */
export interface PlanWindow {
  utilization: number;
  resetsAt: string;
}

/** The subscription's usage: the 5-hour session window and the weekly one. */
export interface PlanUsage {
  session: PlanWindow;
  week: PlanWindow;
  /** False when Claude refuses requests until a window resets. */
  allowed: boolean;
  checkedAt: string;
}

const CACHE_MS = 2 * 60_000;
const PROBE_MODEL = "claude-haiku-4-5";

function windowOf(headers: Headers, name: "5h" | "7d"): PlanWindow | undefined {
  const utilization = Number(headers.get(`anthropic-ratelimit-unified-${name}-utilization`));
  const reset = Number(headers.get(`anthropic-ratelimit-unified-${name}-reset`));
  if (!Number.isFinite(utilization) || !Number.isFinite(reset) || reset <= 0) return undefined;
  return { utilization: Math.min(1, Math.max(0, utilization)), resetsAt: new Date(reset * 1000).toISOString() };
}

/** The plan usage in Anthropic's unified rate-limit headers, or undefined when they are missing. */
export function usageFromHeaders(headers: Headers, now: Date): PlanUsage | undefined {
  const session = windowOf(headers, "5h");
  const week = windowOf(headers, "7d");
  if (!session || !week) return undefined;
  return { session, week, allowed: headers.get("anthropic-ratelimit-unified-status") !== "rejected", checkedAt: now.toISOString() };
}

/**
 * Reads the subscription's usage. The long-lived token cannot call the usage endpoint (it lacks
 * `user:profile`), but every Messages response carries the plan's rate-limit headers, so it asks
 * Haiku for one token and reads them. Cached for two minutes.
 */
export class PlanUsageReader {
  private cached: { at: number; usage: PlanUsage | undefined } | undefined;
  private pending: Promise<PlanUsage | undefined> | undefined;

  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<PlanUsage | undefined> {
    const at = this.now().getTime();
    if (this.cached && at - this.cached.at < CACHE_MS) return this.cached.usage;
    this.pending ??= this.probe().finally(() => (this.pending = undefined));
    const usage = await this.pending;
    this.cached = { at, usage };
    return usage;
  }

  private async probe(): Promise<PlanUsage | undefined> {
    try {
      const response = await this.fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "." }] }),
        signal: AbortSignal.timeout(20_000),
      });
      await response.body?.cancel();
      return usageFromHeaders(response.headers, this.now());
    } catch {
      return undefined;
    }
  }
}

/** `GET /api/usage`: the plan usage for Configuración, or 503 when it cannot be read now. */
export function registerUsageRoutes(app: FastifyInstance, helpers: RouteHelpers, reader: PlanUsageReader): void {
  app.get("/api/usage", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const usage = await reader.read();
    return usage ? reply.send(usage) : reply.code(503).send({ error: "unavailable" });
  });
}
