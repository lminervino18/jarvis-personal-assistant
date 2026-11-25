import type { GmailAccountLabel } from "@jarvis/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteHelpers } from "../../app.js";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";
import type { IntegrationStatusSource } from "../../tools/types.js";
import { GoogleAccessTokens } from "../google/access-tokens.js";
import { GoogleAccountStore } from "../google/account-store.js";
import { GoogleConnector } from "../google/connector.js";
import { DRIVE_SCOPE, GoogleOAuthClient } from "../google/oauth-client.js";
import { DriveClient } from "../drive/drive-client.js";
import type { DriveServices } from "../../tools/drive-tools.js";
import { OAuthStateStore } from "../oauth-states.js";
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

export interface GmailAccountSummary {
  label: GmailAccountLabel;
  email: string;
  status: string;
  /** The account also granted Google Drive access. */
  drive: boolean;
}

export interface GmailIntegration {
  service?: GmailService;
  /** The connected accounts, for the settings screen; undefined when Gmail is not configured. */
  accounts?(): GmailAccountSummary[];
  statusSource: IntegrationStatusSource;
  /** Google Drive through the same accounts; undefined when Google is not configured. */
  drive?: DriveServices;
  driveStatus?: IntegrationStatusSource;
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
  const driveReady = (label: GmailAccountLabel) => {
    const account = accounts.get(label);
    return account?.status === "connected" && account.scopes.includes(DRIVE_SCOPE);
  };
  return {
    service,
    drive: { client: new DriveClient(tokens, deps.fetchFn), ready: driveReady },
    driveStatus: {
      status: async () => [
        driveReady("personal")
          ? { provider: "drive", account: accounts.get("personal")?.email, status: "connected", detail: "Manejo el Drive del dueño; lo que guardo va a la carpeta Jarvis." }
          : { provider: "drive", status: "disconnected", detail: "Se conecta reconectando la cuenta de Google personal desde Configuración." },
      ],
    },
    accounts: () => accounts.list().map(({ label, email, status }) => ({ label, email, status, drive: driveReady(label) })),
    statusSource: service,
    registerRoutes: (app, helpers) => registerGoogleRoutes(app, helpers, { connector, publicOrigin: deps.publicOrigin }),
  };
}
