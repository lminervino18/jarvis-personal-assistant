import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import { previewKind } from "../transfers/transfer-previews.js";
import type { TransferStore } from "../transfers/transfer-store.js";
import type { Welcome } from "./welcome.js";

const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  phrase: z.string().trim().min(2).max(160).optional(),
  musicStart: z.number().min(0).max(3600).optional(),
});
const MusicBody = z.object({ transferId: z.uuid() });

/** The owner's welcome: its settings, the song chosen from Transferencias, and the mixed audio the app plays. */
export function registerWelcomeRoutes(app: FastifyInstance, helpers: RouteHelpers, deps: { welcome: Welcome; transfers: TransferStore; transfersDir: string }): void {
  const { welcome } = deps;
  const view = () => ({ ...welcome.settings(), available: welcome.available, version: welcome.version() });

  app.get("/api/welcome", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    return view();
  });

  app.put("/api/welcome", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = SettingsBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid" });
    welcome.update(body.data);
    return view();
  });

  app.put("/api/welcome/music", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const body = MusicBody.safeParse(request.body);
    const transfer = body.success ? deps.transfers.get(body.data.transferId, new Date()) : undefined;
    const kind = transfer ? previewKind(transfer) : undefined;
    if (!transfer || (kind !== "audio" && kind !== "video")) return reply.code(404).send({ error: "not_found" });
    welcome.setMusic(join(deps.transfersDir, transfer.uploadId), transfer.name);
    return view();
  });

  app.delete("/api/welcome/music", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    welcome.removeMusic();
    return view();
  });

  app.get("/api/welcome/audio", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    const path = await welcome.audio().catch(() => undefined);
    if (!path) return reply.code(503).send({ error: "unavailable" });
    return reply.header("Content-Type", "audio/mpeg").header("Cache-Control", "private, max-age=31536000, immutable").send(createReadStream(path));
  });
}
