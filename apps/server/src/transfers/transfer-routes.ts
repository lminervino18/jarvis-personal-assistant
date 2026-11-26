import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { FileStore } from "@tus/file-store";
import { Server, type Upload } from "@tus/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import type { Db } from "../db/database.js";
import { NOTIFICATION_TITLE } from "../push/notification.js";
import { safeFileName } from "../tasks/workspace.js";
import { Outbox } from "../worker/outbox.js";
import { previewKind, type PreviewSize, type TransferPreviews } from "./transfer-previews.js";
import { UPLOAD_LINK_MAX_BYTES, type Transfer, type TransferStore, type UploadLink } from "./transfer-store.js";

export const UPLOADS_PATH = "/api/transfers/uploads";
export const TRANSFERS_PAGE = "/transferencias";
/** The header a public upload page sends with its link token. */
export const UPLOAD_LINK_HEADER = "upload-link";
const MAX_FILE_BYTES = 20 * 1024 ** 3;
/** Free disk an upload must leave behind, so files never crowd out the database. */
const DISK_RESERVE_BYTES = 10 * 1024 ** 3;
const UNFINISHED_TTL_MS = 24 * 3_600_000;
/** Files arriving together become one notification. */
const NOTIFY_WINDOW_MS = 2 * 60_000;
const PREVIEWABLE = /^(image|video|audio)\/[\w.+-]+$|^application\/pdf$/;

const IdParams = z.object({ id: z.uuid() });
const PreviewQuery = z.object({ size: z.enum(["thumb", "large"]).default("thumb") });
const TokenParams = z.object({ token: z.string().regex(/^[\w-]{20,40}$/) });
const LinkBody = z.object({ label: z.string().trim().min(1).max(60).optional() }).optional();

export interface TransferRoutesDeps {
  db: Db;
  store: TransferStore;
  /** Where uploaded files wait to be downloaded. */
  dir: string;
  publicOrigin: string;
  ownerName: string;
  /** Free bytes on the disk that holds `dir`. */
  freeBytes(): number;
  /** JPEG previews of photos and videos; without it files show only their name. */
  previews?: TransferPreviews;
  now?(): Date;
}

/** Who is uploading, decided by the server: the owner from one of their devices, or someone with an upload link. */
type Uploader = { origin: "phone" | "computer" } | { origin: "link"; link: UploadLink };

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : undefined;
}

export function transferUrls(publicOrigin: string) {
  return {
    upload: (token: string) => `${publicOrigin}/subir/${token}`,
    share: (token: string) => `${publicOrigin}/bajar/${token}`,
  };
}

/**
 * Transfers: files that pass between the owner's devices, or come from someone with a link, byte for
 * byte. Uploads are resumable (tus), downloads accept ranges, and everything is deleted after a day.
 */
export function registerTransferRoutes(app: FastifyInstance, helpers: RouteHelpers, deps: TransferRoutesDeps): { sweep(): Promise<number> } {
  const { store } = deps;
  const now = () => deps.now?.() ?? new Date();
  const urls = transferUrls(deps.publicOrigin);
  const outbox = new Outbox(deps.db);
  const datastore = new FileStore({ directory: deps.dir, expirationPeriodInMilliseconds: UNFINISHED_TTL_MS });
  const uploaders = new WeakMap<IncomingMessage, Uploader>();
  const uploaderOf = (request: unknown) => {
    const node = (request as { runtime?: { node?: { req?: IncomingMessage } } }).runtime?.node?.req;
    return node ? uploaders.get(node) : undefined;
  };

  const notify = (transfer: Transfer) => {
    if (transfer.origin === "phone") return;
    const at = now();
    const window = Math.floor(at.getTime() / NOTIFY_WINDOW_MS);
    const source = transfer.linkId ?? "computer";
    const from = transfer.origin === "link" ? `${transfer.sender ?? "Alguien"} te mandó archivos` : `Llegó «${transfer.name}» desde la compu`;
    const text =
      transfer.origin === "link"
        ? `${transfer.sender ?? "Alguien"} te mandó archivos con tu link: están en Transferencias, en calidad original. Se borran a las 24 horas.`
        : `Llegó «${transfer.name}» desde la compu: está en Transferencias, en calidad original. Se borra a las 24 horas.`;
    outbox.enqueue({ kind: "push", dedupeKey: `transfers:${source}:${window}:push`, payload: { title: NOTIFICATION_TITLE, body: `${from}.`, tag: `transfers:${source}`, url: TRANSFERS_PAGE } }, at);
    outbox.enqueue({ kind: "chat_message", dedupeKey: `transfers:${source}:${window}:chat`, payload: { text, cards: [] } }, at);
  };

  const finish = (upload: Upload, uploader: Uploader) => {
    const transfer = store.add(
      {
        origin: uploader.origin,
        ...(uploader.origin === "link" ? { linkId: uploader.link.id, ...(uploader.link.label ? { sender: uploader.link.label } : {}) } : {}),
        name: safeFileName(upload.metadata?.filename ?? "archivo"),
        mediaType: (upload.metadata?.filetype ?? "").slice(0, 100) || "application/octet-stream",
        size: upload.size ?? upload.offset,
        uploadId: upload.id,
      },
      now(),
    );
    notify(transfer);
  };

  const tus = new Server({
    path: UPLOADS_PATH,
    datastore,
    maxSize: MAX_FILE_BYTES,
    relativeLocation: true,
    async onIncomingRequest(request, uploadId) {
      const uploader = uploaderOf(request);
      if (!uploader) throw { status_code: 401, body: "unauthorized\n" };
      if (!uploadId) return;
      const upload = await datastore.getUpload(uploadId).catch(() => undefined);
      const owner = uploader.origin === "link" ? `link:${uploader.link.id}` : "owner";
      if (upload && upload.metadata?.owner !== owner) throw { status_code: 403, body: "forbidden\n" };
    },
    async onUploadCreate(request, upload) {
      const uploader = uploaderOf(request);
      if (!uploader) throw { status_code: 401, body: "unauthorized\n" };
      if (upload.size === undefined) throw { status_code: 400, body: "size_required\n" };
      if (upload.size + DISK_RESERVE_BYTES > deps.freeBytes()) throw { status_code: 507, body: "insufficient_storage\n" };
      if (uploader.origin === "link" && store.receivedThrough(uploader.link.id) + upload.size > UPLOAD_LINK_MAX_BYTES) throw { status_code: 413, body: "link_quota\n" };
      const owner = uploader.origin === "link" ? `link:${uploader.link.id}` : "owner";
      return { metadata: { ...upload.metadata, owner } };
    },
    async onUploadFinish(request, upload) {
      const uploader = uploaderOf(request);
      if (uploader) finish(upload, uploader);
      return {};
    },
  });

  const handleUpload = async (request: FastifyRequest, reply: FastifyReply) => {
    const linkToken = request.headers[UPLOAD_LINK_HEADER];
    const link = typeof linkToken === "string" ? store.uploadLink(linkToken, now()) : undefined;
    if (link) uploaders.set(request.raw, { origin: "link", link });
    else if (helpers.requireOwner(request)) uploaders.set(request.raw, { origin: request.headers["upload-device"] === "computer" ? "computer" : "phone" });
    reply.hijack();
    await tus.handle(request.raw, reply.raw);
  };

  const sendFile = (request: FastifyRequest, reply: FastifyReply, transfer: Transfer) => {
    const path = join(deps.dir, transfer.uploadId);
    const size = statSync(path).size;
    const range = parseRange(request.headers.range, size);
    reply
      .header("Content-Type", PREVIEWABLE.test(transfer.mediaType) ? transfer.mediaType : "application/octet-stream")
      .header("Content-Disposition", contentDisposition(transfer.name))
      .header("Content-Security-Policy", "sandbox")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .header("Accept-Ranges", "bytes");
    if (!range) return reply.header("Content-Length", size).send(createReadStream(path));
    return reply
      .code(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
      .header("Content-Length", range.end - range.start + 1)
      .send(createReadStream(path, { start: range.start, end: range.end }));
  };

  const sendPreview = async (request: FastifyRequest, reply: FastifyReply, transfer: Transfer) => {
    const query = PreviewQuery.safeParse(request.query);
    const size: PreviewSize = query.success ? query.data.size : "thumb";
    const path = await deps.previews?.get(transfer, size);
    if (!path) return reply.code(404).send({ error: "no_preview" });
    return reply
      .header("Content-Type", "image/jpeg")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600")
      .send(createReadStream(path));
  };

  const view = (transfer: Transfer) => ({
    id: transfer.id,
    origin: transfer.origin,
    ...(transfer.sender ? { sender: transfer.sender } : {}),
    name: transfer.name,
    mediaType: transfer.mediaType,
    size: transfer.size,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
    preview: deps.previews ? (previewKind(transfer) ?? null) : null,
  });

  const remove = async (transfer: Transfer) => {
    deps.previews?.remove(transfer.uploadId);
    await datastore.remove(transfer.uploadId).catch(() => undefined);
    store.markDeleted(transfer.id, now());
  };

  void app.register(async (scope) => {
    scope.addContentTypeParser("application/offset+octet-stream", (_request, _payload, done) => done(null));
    scope.all(UPLOADS_PATH, { config: { rateLimit: false } }, handleUpload);
    scope.all(`${UPLOADS_PATH}/*`, { config: { rateLimit: false } }, handleUpload);
  });

  app.get("/api/transfers", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    return { items: store.list(now()).map(view), links: store.uploadLinks(now()) };
  });

  app.get("/api/transfers/:id/content", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const transfer = params.success ? store.get(params.data.id, now()) : undefined;
    return transfer ? sendFile(request, reply, transfer) : reply.code(404).send({ error: "not_found" });
  });

  app.get("/api/transfers/:id/preview", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const transfer = params.success ? store.get(params.data.id, now()) : undefined;
    return transfer ? sendPreview(request, reply, transfer) : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/api/transfers/:id", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const transfer = params.success ? store.get(params.data.id, now()) : undefined;
    if (!transfer) return reply.code(404).send({ error: "not_found" });
    await remove(transfer);
    return { ok: true };
  });

  app.post("/api/transfers/:id/share", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const shared = params.success ? store.createShareLink(params.data.id, now()) : undefined;
    return shared ? { url: urls.share(shared.token), expiresAt: shared.expiresAt } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/api/transfers/links", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = LinkBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { token, link } = store.createUploadLink(body.data?.label, now());
    return { url: urls.upload(token), link };
  });

  app.delete("/api/transfers/links/:id", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    return params.success && store.revokeLink(params.data.id, now()) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.get("/api/public/upload-links/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    const link = params.success ? store.uploadLink(params.data.token, now()) : undefined;
    return link ? { ownerName: deps.ownerName, expiresAt: link.expiresAt } : reply.code(404).send({ error: "not_found" });
  });

  app.get("/api/public/files/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    const transfer = params.success ? store.shared(params.data.token, now()) : undefined;
    if (!transfer) return reply.code(404).send({ error: "not_found" });
    return {
      name: transfer.name,
      mediaType: transfer.mediaType,
      size: transfer.size,
      expiresAt: transfer.expiresAt,
      ownerName: deps.ownerName,
      preview: deps.previews ? (previewKind(transfer) ?? null) : null,
    };
  });

  app.get("/api/public/files/:token/preview", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    const transfer = params.success ? store.shared(params.data.token, now()) : undefined;
    return transfer ? sendPreview(request, reply, transfer) : reply.code(404).send({ error: "not_found" });
  });

  app.get("/api/public/files/:token/content", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    const transfer = params.success ? store.shared(params.data.token, now()) : undefined;
    return transfer ? sendFile(request, reply, transfer) : reply.code(404).send({ error: "not_found" });
  });

  return {
    /** Deletes files past their day, forgets old links and abandoned uploads. Answers how many files left the disk. */
    async sweep() {
      const due = store.expired(now());
      for (const transfer of due) await remove(transfer);
      store.purgeLinks(now());
      await tus.cleanUpExpiredUploads().catch(() => 0);
      return due.length;
    },
  };
}
