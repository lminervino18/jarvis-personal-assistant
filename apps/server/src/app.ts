import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPassword } from "./auth/password.js";
import { SESSION_COOKIE, SessionStore } from "./auth/sessions.js";
import type { AppConfig } from "./config.js";
import type { ConversationStore } from "./conversation/conversation-store.js";
import type { ConversationHub } from "./conversation/hub.js";
import type { ConversationOrchestrator } from "./conversation/orchestrator.js";
import type { Db } from "./db/database.js";
import { allowedOrigins, applySecurityHeaders, isAllowedOrigin } from "./http/security.js";
import type { AssistantContext } from "./runtime/system-prompt.js";
import type { SpeechToTextService, TextToSpeechService } from "./voice/types.js";
import { ClientConnection, type PlayerState, type PushSubscription } from "./ws/client-connection.js";

export interface AppDeps {
  config: AppConfig;
  logger: FastifyBaseLogger;
  db: Db;
  store: ConversationStore;
  hub: ConversationHub;
  orchestrator: ConversationOrchestrator;
  assistantContext: () => AssistantContext;
  stt: SpeechToTextService;
  tts: TextToSpeechService;
  pushPublicKey?: string | null;
  onPushSubscribe?(subscription: PushSubscription, userAgent: string | undefined): Promise<void>;
  onPlayerState?(state: PlayerState): void;
  /** Lets integration modules add their own routes (OAuth callbacks, device gateway). */
  registerRoutes?(app: FastifyInstance, helpers: RouteHelpers): Promise<void> | void;
}

export interface RouteHelpers {
  requireOwner(request: FastifyRequest): boolean;
}

const LoginBody = z.object({ password: z.string().min(1).max(200) });

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: config.env === "production",
    bodyLimit: 64 * 1024,
  });
  const sessions = new SessionStore(deps.db, config.sessionTtlDays);
  const origins = allowedOrigins({
    publicOrigin: config.publicOrigin,
    devOrigins: config.env === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173", `http://localhost:${config.port}`],
  });
  const secureCookie = config.publicOrigin.startsWith("https://");

  const requireOwner = (request: FastifyRequest) => sessions.validate(request.cookies[SESSION_COOKIE]);

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  app.addHook("onSend", async (_request, reply, payload) => {
    applySecurityHeaders(reply, config.publicOrigin);
    return payload;
  });
  app.addHook("preHandler", async (request, reply) => {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutating && request.url.startsWith("/api/") && !isAllowedOrigin(request, origins)) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
  });

  app.get("/healthz", { config: { rateLimit: false } }, async () => {
    deps.db.prepare("SELECT 1").get();
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success || !config.ownerPasswordHash) return reply.code(401).send({ error: "invalid_credentials" });
    const valid = await verifyPassword(body.data.password, config.ownerPasswordHash);
    if (!valid) return reply.code(401).send({ error: "invalid_credentials" });
    const { token, expiresAt } = sessions.create(request.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "strict",
      path: "/",
      expires: expiresAt,
    });
    return { authenticated: true, displayName: config.ownerDisplayName };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    sessions.revoke(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { authenticated: false };
  });

  app.get("/api/auth/session", async (request) => {
    const authenticated = requireOwner(request);
    return authenticated ? { authenticated, displayName: config.ownerDisplayName } : { authenticated };
  });

  app.get("/api/health/context", async (request, reply) => {
    if (!requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const context = deps.assistantContext();
    return { fingerprint: context.fingerprint, profileSource: context.profileSource };
  });

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!isAllowedOrigin(request, origins)) return reply.code(403).send({ error: "forbidden_origin" });
        if (!requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      },
    },
    (socket, request) => {
      const token = request.cookies[SESSION_COOKIE];
      new ClientConnection(socket, {
        kind: "web",
        store: deps.store,
        hub: deps.hub,
        orchestrator: deps.orchestrator,
        stt: deps.stt,
        tts: deps.tts,
        ownerName: config.ownerDisplayName,
        followUpWindowMs: config.followUpWindowMs,
        pushPublicKey: deps.pushPublicKey ?? null,
        log: deps.logger,
        isStillAuthorized: () => sessions.validate(token),
        onPushSubscribe: deps.onPushSubscribe
          ? (subscription) => deps.onPushSubscribe!(subscription, request.headers["user-agent"])
          : undefined,
        onPlayerState: deps.onPlayerState,
      });
    },
  );

  await deps.registerRoutes?.(app, { requireOwner });

  if (config.webDistDir && existsSync(resolve(config.webDistDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      setHeaders(res, path) {
        const noCache = path.endsWith("index.html") || path.endsWith("sw.js") || path.endsWith(".webmanifest");
        res.header("Cache-Control", noCache ? "no-cache" : "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/ws")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
