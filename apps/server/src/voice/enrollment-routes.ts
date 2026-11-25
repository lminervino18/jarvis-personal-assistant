import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteHelpers } from "../app.js";
import type { SpeakerCheck } from "./speaker-check.js";

/** Phrases the owner reads aloud: varied sounds and rhythm, a few seconds each. */
export const ENROLLMENT_PHRASES = [
  "Jarvis, recordame mañana a las nueve que tengo que llamar al contador.",
  "¿Qué tengo en la agenda para el jueves a la tarde?",
  "Mandale un mensaje a mi vieja diciéndole que llego tarde a cenar.",
  "Buscame las últimas noticias sobre inteligencia artificial y energía solar.",
  "Leeme los correos importantes que llegaron hoy y decime si hay algo urgente.",
  "Pará un segundo, no era eso; quiero que lo cambies por el viernes.",
  "Armá una página para el cumpleaños de Juli con fotos y una encuesta.",
  "Gracias, eso es todo por ahora. Después seguimos con el proyecto.",
] as const;

const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 20;
const MIN_SECONDS = 2;
const IndexParams = z.object({ index: z.coerce.number().int().min(0).max(ENROLLMENT_PHRASES.length - 1) });

export interface EnrollmentDeps {
  dir: string;
  speaker: SpeakerCheck;
}

/**
 * The owner's voice samples: one recording per phrase, as 16 kHz mono 16-bit PCM. Once every phrase
 * is recorded the voiceprint is rebuilt. Recordings stay on the server's data volume, never in Git.
 */
export function registerEnrollmentRoutes(app: FastifyInstance, helpers: RouteHelpers, deps: EnrollmentDeps): void {
  const file = (index: number) => join(deps.dir, `${index}.pcm`);
  const recorded = () => ENROLLMENT_PHRASES.map((_, index) => index).filter((index) => existsSync(file(index)));
  const state = () => ({ phrases: ENROLLMENT_PHRASES, recorded: recorded(), enrolled: deps.speaker.enrolled(), sampleRate: SAMPLE_RATE });

  app.get("/api/voice/enrollment", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    return state();
  });

  app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: SAMPLE_RATE * 2 * MAX_SECONDS }, (_request, body, done) => done(null, body));
    scope.put("/api/voice/enrollment/:index", async (request, reply) => {
      if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
      const params = IndexParams.safeParse(request.params);
      const body = request.body;
      if (!params.success || !Buffer.isBuffer(body)) return reply.code(400).send({ error: "invalid_request" });
      if (body.length < SAMPLE_RATE * 2 * MIN_SECONDS) return reply.code(400).send({ error: "too_short" });
      mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
      writeFileSync(file(params.data.index), body, { mode: 0o600 });
      const done = recorded();
      if (done.length === ENROLLMENT_PHRASES.length) await deps.speaker.enroll(done.map((index) => readFileSync(file(index))), SAMPLE_RATE);
      return state();
    });
  });

  app.delete("/api/voice/enrollment", async (request, reply) => {
    if (!helpers.requireOwner(request)) return reply.code(401).send({ error: "unauthorized" });
    rmSync(deps.dir, { recursive: true, force: true });
    deps.speaker.forget();
    return state();
  });
}
