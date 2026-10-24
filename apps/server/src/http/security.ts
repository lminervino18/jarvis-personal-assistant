import type { FastifyReply, FastifyRequest } from "fastify";

export interface SecurityOptions {
  publicOrigin: string;
  /** Extra origins accepted in development (e.g. the Vite dev server). */
  devOrigins: string[];
}

export function allowedOrigins(options: SecurityOptions): Set<string> {
  return new Set([options.publicOrigin, ...options.devOrigins]);
}

/** Browsers always send Origin on WebSocket upgrades and cross-site POSTs; require an exact match. */
export function isAllowedOrigin(request: FastifyRequest, origins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origins.has(origin);
}

export function contentSecurityPolicy(publicOrigin: string): string {
  const wsOrigin = publicOrigin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://i.ytimg.com",
    "media-src 'self' blob:",
    `connect-src 'self' ${wsOrigin}`,
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function applySecurityHeaders(reply: FastifyReply, publicOrigin: string): void {
  reply.header("Content-Security-Policy", contentSecurityPolicy(publicOrigin));
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=()");
  if (publicOrigin.startsWith("https://")) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}
