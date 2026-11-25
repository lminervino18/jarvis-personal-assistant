import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import type { TokenCipher } from "../crypto/token-cipher.js";
import type { Db } from "../db/database.js";
import type { IntegrationStatusItem, IntegrationStatusSource } from "../tools/types.js";
import { GitHubClient, GitHubError } from "./github/github-client.js";
import { OAuthStateStore } from "./oauth-states.js";
import { ServiceAccountStore, type ServiceProvider } from "./service-accounts.js";
import { VercelClient, VercelError } from "./vercel/vercel-client.js";

export interface ConnectionsDeps {
  db: Db;
  /** The live WhatsApp bridge's status and, while it waits for a scan, its pairing card. */
  whatsapp?: IntegrationStatusSource;
  /** Gmail accounts, shown with the other connections; undefined when Gmail is not configured. */
  gmailAccounts?(): { label: string; email: string; status: string; drive: boolean }[];
  env: NodeJS.ProcessEnv;
  cipher?: TokenCipher;
  publicOrigin: string;
  fetchFn?: typeof fetch;
}

export interface Connections {
  accounts?: ServiceAccountStore;
  github?: GitHubClient;
  vercel: VercelClient;
  /** Parent domain for published projects, such as `example.com` for `<slug>.example.com`. */
  projectsDomain?: string;
  statusSource: IntegrationStatusSource;
  registerRoutes(app: FastifyInstance, helpers: RouteHelpers): void;
}

const ROUTE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const CallbackQuery = z.object({ code: z.string().min(1).max(512).optional(), state: z.string().min(1).max(256).optional(), error: z.string().max(200).optional() });
const VercelBody = z.object({ token: z.string().trim().min(10).max(200) });
const ProviderParams = z.object({ provider: z.enum(["github", "vercel"]) });

function resultUrl(publicOrigin: string, params: Record<string, string>): string {
  return `${publicOrigin}/?${new URLSearchParams({ integration: "github", ...params }).toString()}`;
}

/** GitHub (OAuth link) and Vercel (pasted token): the accounts JARVIS publishes projects with. */
export function createConnections(deps: ConnectionsDeps): Connections {
  const { db, env, cipher, publicOrigin } = deps;
  const accounts = cipher ? new ServiceAccountStore(db, cipher) : undefined;
  const states = cipher ? new OAuthStateStore<"owner">(db, cipher, "github") : undefined;
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? new GitHubClient({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: `${publicOrigin}/api/integrations/github/callback` }, deps.fetchFn)
      : undefined;
  const vercel = new VercelClient(deps.fetchFn);
  const projectsDomain = env.PROJECTS_DOMAIN?.trim() || undefined;

  const status = async (): Promise<IntegrationStatusItem[]> => {
    const githubAccount = accounts?.get("github");
    const vercelAccount = accounts?.get("vercel");
    return [
      githubAccount
        ? { provider: "github", account: githubAccount.account, status: "connected", detail: "Puedo crear repositorios, subir ramas y abrir PR cuando el dueño lo aprueba." }
        : github && accounts
          ? { provider: "github", status: "disconnected", detail: "Se conecta desde Configuración › GitHub." }
          : { provider: "github", status: "disabled", detail: "Falta configurar la app de GitHub en el servidor." },
      vercelAccount
        ? { provider: "vercel", account: vercelAccount.account, status: "connected", detail: projectsDomain ? `Publico proyectos en <nombre>.${projectsDomain}.` : "Publico proyectos en vercel.app." }
        : { provider: "vercel", status: accounts ? "disconnected" : "disabled", detail: "Se conecta desde Configuración › Vercel con un token." },
    ];
  };

  const registerRoutes = (app: FastifyInstance, helpers: RouteHelpers) => {
    app.get("/api/connections", async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      const gmail = deps.gmailAccounts?.();
      const bridge = (await deps.whatsapp?.status())?.find((item) => item.account === "baileys");
      return {
        whatsapp: bridge ? { status: bridge.status, detail: bridge.detail, pairing: deps.whatsapp?.pairingCard?.() ?? null } : null,
        gmail: {
          available: Boolean(gmail),
          accounts: (gmail ?? []).filter((account) => account.status !== "revoked").map(({ label, email, status, drive }) => ({ label, email, status, drive })),
        },
        github: { available: Boolean(github && accounts), account: accounts?.get("github")?.account ?? null },
        vercel: { available: Boolean(accounts), account: accounts?.get("vercel")?.account ?? null, domain: projectsDomain ?? null },
      };
    });

    app.get("/api/integrations/github/start", ROUTE_LIMIT, async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      if (!github || !states) return reply.code(503).send({ error: "not_configured" });
      const started = states.start("owner", new Date());
      return reply.redirect(github.authorizationUrl(started.state, started.challenge), 302);
    });

    app.get("/api/integrations/github/callback", ROUTE_LIMIT, async (request, reply) => {
      const query = CallbackQuery.safeParse(request.query);
      if (!github || !states || !accounts || !query.success || !query.data.state) return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "invalid_state" }), 302);
      const pending = states.consume(query.data.state, new Date());
      if (!pending) return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "invalid_state" }), 302);
      if (query.data.error || !query.data.code) return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "denied" }), 302);
      try {
        const token = await github.exchangeCode(query.data.code, pending.verifier);
        const login = await github.user(token);
        accounts.connect({ provider: "github", account: login, token }, new Date());
        return reply.redirect(resultUrl(publicOrigin, { status: "connected", label: login }), 302);
      } catch (error) {
        request.log.warn({ reason: error instanceof GitHubError ? error.message : "unknown" }, "github connect failed");
        return reply.redirect(resultUrl(publicOrigin, { status: "error", reason: "unavailable" }), 302);
      }
    });

    app.post("/api/integrations/vercel/token", ROUTE_LIMIT, async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      if (!accounts) return reply.code(503).send({ error: "not_configured" });
      const body = VercelBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_token" });
      try {
        const account = await vercel.user(body.data.token);
        const teamId = projectsDomain ? await vercel.teamForDomain(body.data.token, projectsDomain) : undefined;
        accounts.connect({ provider: "vercel", account, token: body.data.token, ...(teamId ? { detail: teamId } : {}) }, new Date());
        return { account, domain: teamId ? projectsDomain : null };
      } catch (error) {
        const unauthorized = error instanceof VercelError && error.reason === "unauthorized";
        return reply.code(unauthorized ? 400 : 502).send({ error: unauthorized ? "invalid_token" : "unavailable" });
      }
    });

    app.post("/api/integrations/:provider/disconnect", ROUTE_LIMIT, async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      const params = ProviderParams.safeParse(request.params);
      if (!params.success || !accounts) return reply.code(404).send({ error: "not_found" });
      return { disconnected: accounts.disconnect(params.data.provider as ServiceProvider) };
    });
  };

  return { accounts, github, vercel, projectsDomain, statusSource: { status }, registerRoutes };
}
