import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import type { TaskService } from "./task-service.js";
import type { WorkLayout } from "./workspace.js";

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

const SAFE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".diff", ".patch", ".log", ".ts", ".tsx", ".js", ".mjs", ".py", ".sql", ".yml", ".yaml", ".html", ".css", ".svg", ".xml", ".sh"]);

const RefParams = z.object({ ref: z.coerce.number().int().positive() });
const FileQuery = z.object({ path: z.string().min(1).max(400) });
const UploadQuery = z.object({ name: z.string().min(1).max(200) });

/**
 * Owner-only HTTP routes for delegated tasks: uploading attachments before creating a task,
 * and previewing the latest diff or a deliverable. Agent output is never served as HTML or
 * script: text is plain, images and PDFs keep their type, everything else downloads.
 */
export function registerTaskRoutes(app: FastifyInstance, helpers: RouteHelpers, tasks: TaskService, layout: WorkLayout, maxUploadBytes: number): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: maxUploadBytes }, (_request, body, done) => done(null, body));

    scope.post("/api/tasks/attachments", async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      const query = UploadQuery.safeParse(request.query);
      if (!query.success || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "bad_request" });
      const mediaType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0] ?? "application/octet-stream";
      const attachment = tasks.saveAttachment({ name: query.data.name, mediaType, data: request.body }, new Date());
      if (!attachment) return reply.code(413).send({ error: "invalid_size" });
      return { id: attachment.id, name: attachment.name, size: attachment.size, mediaType: attachment.mediaType };
    });
  });

  app.get("/api/tasks/:ref/diff", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = RefParams.safeParse(request.params);
    const task = params.success ? tasks.byRef(params.data.ref) : undefined;
    if (!task?.evidence) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("Content-Type", "text/plain; charset=utf-8")
      .header("Content-Security-Policy", "sandbox")
      .send(layout.diff(task.id, task.evidence, MAX_PREVIEW_BYTES));
  });

  app.get("/api/tasks/:ref/files", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const params = RefParams.safeParse(request.params);
    const query = FileQuery.safeParse(request.query);
    const task = params.success ? tasks.byRef(params.data.ref) : undefined;
    if (!task || !query.success) return reply.code(404).send({ error: "not_found" });
    const work = layout.paths(task.id).work;
    const target = resolve(work, query.data.path);
    const rel = relative(work, target);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes(".git") || !existsSync(target) || !statSync(target).isFile()) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (statSync(target).size > MAX_PREVIEW_BYTES) return reply.code(413).send({ error: "too_large" });
    const extension = extname(target).toLowerCase();
    const type = SAFE_TYPES[extension] ?? (TEXT_EXTENSIONS.has(extension) ? "text/plain; charset=utf-8" : undefined);
    reply.header("Content-Security-Policy", "sandbox").header("X-Content-Type-Options", "nosniff");
    if (!type) reply.header("Content-Disposition", "attachment");
    return reply.header("Content-Type", type ?? "application/octet-stream").send(readFileSync(target));
  });
}
