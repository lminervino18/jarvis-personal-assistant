import { GmailAccountLabel } from "@jarvis/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../../app.js";
import { ConnectError, type GoogleConnector } from "./connector.js";

const CallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
});
const StartQuery = z.object({ label: GmailAccountLabel });
const RevokeBody = z.object({ label: GmailAccountLabel });

const ROUTE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export interface GoogleRoutesDeps {
  connector: GoogleConnector;
  publicOrigin: string;
}

function resultUrl(publicOrigin: string, params: Record<string, string>): string {
  return `${publicOrigin}/?${new URLSearchParams({ integration: "gmail", ...params }).toString()}`;
}

/**
 * The callback cannot require the owner session cookie (SameSite=Strict cookies are not sent on the
 * cross-site redirect back from Google); its authority is the single-use hashed `state` created by
 * the owner-only start route.
 */
export function registerGoogleRoutes(app: FastifyInstance, helpers: RouteHelpers, deps: GoogleRoutesDeps): void {
  const { connector, publicOrigin } = deps;

  app.get("/api/integrations/google/start", ROUTE_LIMIT, async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const query = StartQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_label" });
    return reply.redirect(connector.authorizationUrl(query.data.label), 302);
  });

  app.get("/api/integrations/google/callback", ROUTE_LIMIT, async (request, reply) => {
    const query = CallbackQuery.safeParse(request.query);
    if (!query.success || !query.data.state) return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "invalid_state" }), 302);
    if (query.data.error || !query.data.code) {
      return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "denied" }), 302);
    }
    try {
      const account = await connector.complete(query.data.code, query.data.state);
      return reply.redirect(resultUrl(publicOrigin, { status: "connected", label: account.label }), 302);
    } catch (error) {
      const reason = error instanceof ConnectError ? error.reason : "unavailable";
      return reply.redirect(resultUrl(publicOrigin, { status: "error", reason }), 302);
    }
  });

  app.post("/api/integrations/google/revoke", ROUTE_LIMIT, async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = RevokeBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_label" });
    const outcome = await connector.revoke(body.data.label);
    if (!outcome) return reply.code(404).send({ error: "not_connected" });
    return { revoked: true, remoteRevoked: outcome.remoteRevoked };
  });
}
