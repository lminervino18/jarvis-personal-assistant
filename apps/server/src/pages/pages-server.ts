import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ALLOWED_SCRIPTS } from "./design-guide.js";
import { withRuntime } from "./page-html.js";
import type { PageService } from "./page-service.js";

const MAX_ANSWER_BYTES = 16 * 1024;
const ANSWERS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${ALLOWED_SCRIPTS.join(" ")}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https:",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cache-control": "no-cache",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function shell(title: string, text: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#fff;color:#0b0a12;font:17px/1.5 system-ui,-apple-system,sans-serif;padding:24px;text-align:center}p{max-width:28em}b{color:#5b2bff}</style></head>
<body><p>${text}</p></body></html>`;
}

const PREVIEWABLE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(ogg|mpeg|mp4|aac|wav)|application\/pdf)$/;

export interface SharedFile {
  name: string;
  mediaType: string;
  data: Buffer;
}

/** Sends a file honoring a single byte range, which iPhones need to play video and audio. */
function sendFile(request: FastifyRequest, reply: FastifyReply, file: { mediaType: string; data: Buffer }): FastifyReply {
  const size = file.data.length;
  reply.header("accept-ranges", "bytes").type(file.mediaType);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
  if (!range || (!range[1] && !range[2])) return reply.send(file.data);
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
  return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).send(file.data.subarray(start, end + 1));
}

/** Counts recent answers per visitor so one person cannot flood a page. */
class AnswerLimiter {
  private readonly recent = new Map<string, number[]>();

  allow(key: string, now: number): boolean {
    const kept = (this.recent.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (kept.length >= ANSWERS_PER_MINUTE) {
      this.recent.set(key, kept);
      return false;
    }
    kept.push(now);
    this.recent.set(key, kept);
    if (this.recent.size > 10_000) this.recent.clear();
    return true;
  }
}

/**
 * The public host for generated pages, on its own origin so page scripts never share cookies or
 * storage with the assistant. It only serves pages and accepts their answers.
 */
export function buildPagesServer(pages: PageService, options: { trustProxy: boolean; sharedFile?: (token: string) => SharedFile | undefined }): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: options.trustProxy, bodyLimit: MAX_ANSWER_BYTES });
  const limiter = new AnswerLimiter();

  app.get("/healthz", async () => ({ ok: true }));

  app.get<{ Params: { slug: string } }>("/:slug", async (request, reply) => {
    reply.headers(SECURITY_HEADERS).type("text/html; charset=utf-8");
    const page = pages.get(request.params.slug);
    if (!page) return reply.code(404).send(shell("No existe", "Esta página no existe o el link está mal escrito."));
    if (!page.html) {
      return page.status === "generating"
        ? reply.send(shell(page.title, "Esta página se está preparando. <b>En unos segundos</b> se actualiza sola.", 5))
        : reply.code(404).send(shell("No disponible", "Esta página no está disponible."));
    }
    return reply.send(withRuntime(page.html, page.slug));
  });

  app.get<{ Params: { slug: string; id: string } }>("/:slug/f/:id", async (request, reply) => {
    const asset = pages.asset(request.params.slug, request.params.id);
    reply.headers({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    if (!asset) return reply.code(404).send();
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return sendFile(request, reply, asset);
  });

  app.get<{ Params: { token: string } }>("/d/:token", async (request, reply) => {
    const file = /^[A-Za-z0-9_-]{16,64}$/.test(request.params.token) ? options.sharedFile?.(request.params.token) : undefined;
    reply.headers({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex", "cache-control": "private, max-age=3600" });
    if (!file) return reply.headers(SECURITY_HEADERS).type("text/html; charset=utf-8").code(404).send(shell("Link vencido", "Este link venció o no existe."));
    const previewable = PREVIEWABLE.test(file.mediaType);
    const name = encodeURIComponent(file.name);
    reply.header("content-security-policy", "sandbox").header("content-disposition", `${previewable ? "inline" : "attachment"}; filename*=UTF-8''${name}`);
    return sendFile(request, reply, { mediaType: previewable ? file.mediaType : "application/octet-stream", data: file.data });
  });

  app.post<{ Params: { slug: string } }>("/r/:slug", async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (!limiter.allow(`${request.ip}:${request.params.slug}`, Date.now())) return reply.code(429).send({ ok: false });
    const outcome = pages.recordResponse(request.params.slug, request.body);
    return outcome.ok ? reply.code(204).send() : reply.code(outcome.status).send({ ok: false });
  });

  app.get("/", async (_request, reply) => reply.headers(SECURITY_HEADERS).type("text/html; charset=utf-8").code(404).send(shell("JARVIS", "Nada por acá.")));

  return app;
}
