import type { FastifyInstance } from "fastify";
import type { RouteHelpers } from "../../app.js";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";
import type { IntegrationStatusSource } from "../../tools/types.js";
import { GoogleAccessTokens } from "../google/access-tokens.js";
import { GoogleAccountStore } from "../google/account-store.js";
import { GoogleConnector } from "../google/connector.js";
import { GoogleOAuthClient } from "../google/oauth-client.js";
import { OAuthStateStore } from "../google/oauth-states.js";
import { registerGoogleRoutes } from "../google/routes.js";
import { GmailClient } from "./client.js";
import { GmailService } from "./gmail-service.js";

export interface GmailIntegrationDeps {
  db: Db;
  env: NodeJS.ProcessEnv;
  cipher?: TokenCipher;
  publicOrigin: string;
  timezone: string;
  fetchFn?: typeof fetch;
}

export interface GmailIntegration {
  service?: GmailService;
  statusSource: IntegrationStatusSource;
  registerRoutes(app: FastifyInstance, helpers: RouteHelpers): void;
}

function missingSettings(env: NodeJS.ProcessEnv, cipher: TokenCipher | undefined): string[] {
  return [
    ...(env.GOOGLE_CLIENT_ID ? [] : ["GOOGLE_CLIENT_ID"]),
    ...(env.GOOGLE_CLIENT_SECRET ? [] : ["GOOGLE_CLIENT_SECRET"]),
    ...(cipher ? [] : ["TOKEN_ENCRYPTION_KEY"]),
  ];
}

function disabledIntegration(missing: string[]): GmailIntegration {
  const detail = `Gmail no está configurado; faltan: ${missing.join(", ")}.`;
  return {
    statusSource: { status: async () => [{ provider: "gmail", status: "disabled", detail }] },
    registerRoutes() {},
  };
}

/** Builds the Gmail integration, or a disabled one that only reports what is missing. */
export function createGmailIntegration(deps: GmailIntegrationDeps): GmailIntegration {
  const { db, env, cipher } = deps;
  const missing = missingSettings(env, cipher);
  if (!cipher || missing.length > 0) return disabledIntegration(missing);

  const redirectUri = env.GOOGLE_REDIRECT_URI ?? `${deps.publicOrigin}/api/integrations/google/callback`;
  const oauth = new GoogleOAuthClient(
    { clientId: env.GOOGLE_CLIENT_ID as string, clientSecret: env.GOOGLE_CLIENT_SECRET as string, redirectUri },
    deps.fetchFn,
  );
  const accounts = new GoogleAccountStore(db, cipher);
  accounts.rewrapTokens();
  const tokens = new GoogleAccessTokens(accounts, oauth);
  const connector = new GoogleConnector(oauth, new OAuthStateStore(db, cipher), accounts, tokens);
  const service = new GmailService(accounts, new GmailClient(tokens, deps.timezone, deps.fetchFn));
  return {
    service,
    statusSource: service,
    registerRoutes: (app, helpers) => registerGoogleRoutes(app, helpers, { connector, publicOrigin: deps.publicOrigin }),
  };
}
