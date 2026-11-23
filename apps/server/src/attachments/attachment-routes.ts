import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import { transcribeAudioFile, type AudioFileTranscriber, type AudioTranscriptionError } from "../voice/audio-file-transcription.js";
import { MAX_ATTACHMENT_BYTES, type AttachmentStore } from "./attachment-store.js";

const UploadQuery = z.object({ name: z.string().min(1).max(200) });
const IdParams = z.object({ id: z.uuid() });
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const TRANSCRIBE_STATUS: Record<AudioTranscriptionError, number> = {
  unsupported_type: 415,
  empty_file: 400,
  file_too_large: 413,
  stt_unavailable: 503,
  transcription_failed: 502,
};

/**
 * Owner-only upload and preview of chat attachments. Previews keep images and PDFs inline and
 * download everything else; nothing is ever served as HTML or script.
 */
export function registerAttachmentRoutes(app: FastifyInstance, helpers: RouteHelpers, attachments: AttachmentStore, stt?: AudioFileTranscriber): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES }, (_request, body, done) => done(null, body));

    scope.post("/api/attachments", async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      const query = UploadQuery.safeParse(request.query);
      if (!query.success || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "bad_request" });
      const mediaType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0] ?? "application/octet-stream";
      const attachment = attachments.save({ name: query.data.name, mediaType, data: request.body }, new Date());
      if (!attachment) return reply.code(413).send({ error: "invalid_size" });
      return { id: attachment.id, name: attachment.name, size: attachment.size, mediaType: attachment.mediaType };
    });

    scope.post("/api/attachments/transcribe", async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "bad_request" });
      const result = await transcribeAudioFile(stt, { data: request.body, mediaType: request.headers["content-type"] ?? "" });
      if (result.ok) return { text: result.text };
      return reply.code(TRANSCRIBE_STATUS[result.error]).send({ error: result.error });
    });
  });

  app.get("/api/attachments/:id", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = IdParams.safeParse(request.params);
    const stored = params.success ? attachments.read(params.data.id) : undefined;
    if (!stored) return reply.code(404).send({ error: "not_found" });
    const inline = INLINE_TYPES.has(stored.attachment.mediaType);
    reply.header("Content-Security-Policy", "sandbox").header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, max-age=86400");
    if (!inline) reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(stored.attachment.name)}"`);
    return reply.header("Content-Type", inline ? stored.attachment.mediaType : "application/octet-stream").send(stored.data);
  });
}
