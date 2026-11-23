import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import type { AttachmentStore } from "../attachments/attachment-store.js";
import { sendFile } from "../pages/pages-server.js";
import type { SendInput, SendOutcome } from "./video-delivery.js";
import { versionDir } from "./video-paths.js";
import type { VideoStore } from "./video-store.js";

const IdParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });
const SendBody = z.object({ version: z.number().int().positive() });
const FileParams = VersionParams.extend({ name: z.string().regex(/^[a-z0-9-]+\.(wav|jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i) });

const TYPES: Record<string, string> = { wav: "audio/wav", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/**
 * Owner-only access to videos: the live card, the timeline the in-app preview plays, its narration
 * and pictures, and the finished MP4 with byte ranges so phones can play it inline.
 */
export function registerVideoRoutes(
  app: FastifyInstance,
  helpers: RouteHelpers,
  videos: VideoStore,
  attachments: AttachmentStore,
  videosDir: string,
  send: (input: SendInput) => Promise<SendOutcome>,
): void {
  app.post("/api/videos/:id/send", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const body = SendBody.safeParse(request.body);
    const requested = params.success ? videos.get(params.data.id)?.send : undefined;
    if (!params.success || !body.success || !requested) return reply.code(404).send({ error: "not_found" });
    if (requested.status === "pending" || requested.status === "failed") {
      const { channel, to, text, subject, account } = requested;
      const outcome = await send({ videoId: params.data.id, version: body.data.version, channel, to, ...(text ? { text } : {}), ...(subject ? { subject } : {}), ...(account ? { account } : {}) });
      if (!outcome.ok) return reply.code(409).send({ error: outcome.message, card: videos.card(params.data.id) });
    }
    return videos.card(params.data.id);
  });

  app.get("/api/videos/:id", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const card = params.success ? videos.card(params.data.id) : undefined;
    return card ?? reply.code(404).send({ error: "not_found" });
  });

  app.get("/api/videos/:id/v/:version/timeline", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = VersionParams.safeParse(request.params);
    const version = params.success ? videos.version(params.data.id, params.data.version) : undefined;
    if (!params.success || !version?.timeline) return reply.code(404).send({ error: "not_found" });
    return { ...version.timeline, assetBase: `/api/videos/${params.data.id}/v/${params.data.version}/files` };
  });

  app.get("/api/videos/:id/v/:version/files/:name", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = FileParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const { id, version, name } = params.data;
    let data: Buffer;
    try {
      data = readFileSync(join(versionDir(videosDir, id, version), name));
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("Cache-Control", "private, max-age=86400");
    return sendFile(request, reply, { mediaType: TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream", data });
  });

  app.get("/api/videos/:id/v/:version/watch", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = VersionParams.safeParse(request.params);
    const version = params.success ? videos.version(params.data.id, params.data.version) : undefined;
    const stored = version?.files.full ? attachments.read(version.files.full.attachmentId) : undefined;
    if (!stored) return reply.code(404).send({ error: "not_found" });
    reply.header("Cache-Control", "private, max-age=86400");
    return sendFile(request, reply, { mediaType: "video/mp4", data: stored.data });
  });
}
