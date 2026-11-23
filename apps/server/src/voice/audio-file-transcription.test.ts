import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerAttachmentRoutes } from "../attachments/attachment-routes.js";
import { MAX_AUDIO_BYTES, transcribeAudioFile } from "./audio-file-transcription.js";
import { OpenAiCompatibleStt } from "./openai-stt.js";

const OGG = readFileSync(new URL("../../fixtures/synthetic/audio/synthetic.ogg", import.meta.url));

function fixture(status = 200) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    status === 200 ? Response.json({ text: " hola, nos vemos a las cinco " }) : new Response("nope", { status }),
  );
  const stt = new OpenAiCompatibleStt({ provider: "groq", baseUrl: "https://stt.example/v1", model: "m", apiKey: "secret-key", language: "es", fetch: fetcher as typeof fetch });
  return { fetcher, stt };
}

describe("audio file transcription", () => {
  it("sends a synthetic ogg to /audio/transcriptions and returns the text", async () => {
    const { fetcher, stt } = fixture();
    const result = await transcribeAudioFile(stt, { data: OGG, mediaType: "audio/ogg; codecs=opus" });
    expect(result).toEqual({ ok: true, text: "hola, nos vemos a las cinco" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://stt.example/v1/audio/transcriptions");
    const form = init?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(OGG.length);
    expect(form.get("model")).toBe("m");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
  });

  it("rejects unsupported types, empty and oversized files without calling the STT", async () => {
    const { fetcher, stt } = fixture();
    expect(await transcribeAudioFile(stt, { data: OGG, mediaType: "video/mp4" })).toEqual({ ok: false, error: "unsupported_type" });
    expect(await transcribeAudioFile(stt, { data: OGG, mediaType: "" })).toEqual({ ok: false, error: "unsupported_type" });
    expect(await transcribeAudioFile(stt, { data: new Uint8Array(0), mediaType: "audio/wav" })).toEqual({ ok: false, error: "empty_file" });
    expect(await transcribeAudioFile(stt, { data: new Uint8Array(MAX_AUDIO_BYTES + 1), mediaType: "audio/mpeg" })).toEqual({ ok: false, error: "file_too_large" });
    expect(await transcribeAudioFile(undefined, { data: OGG, mediaType: "audio/ogg" })).toEqual({ ok: false, error: "stt_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports provider failures as a structured error without leaking details", async () => {
    const { stt } = fixture(500);
    const result = await transcribeAudioFile(stt, { data: OGG, mediaType: "audio/mp4" });
    expect(result).toEqual({ ok: false, error: "transcription_failed" });
  });

  it("serves the transcription to the owner only", async () => {
    const { fetcher, stt } = fixture();
    const app = Fastify();
    registerAttachmentRoutes(app, { requireOwner: (request) => request.headers["x-owner"] === "yes" }, undefined as never, stt);
    const post = (type: string, headers: Record<string, string>, payload: Buffer = OGG) =>
      app.inject({ method: "POST", url: "/api/attachments/transcribe", headers: { "content-type": type, ...headers }, payload });

    expect((await post("audio/ogg", {})).statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const bad = await post("image/png", { "x-owner": "yes" });
    expect(bad.statusCode).toBe(415);
    expect(bad.json()).toEqual({ error: "unsupported_type" });
    expect(fetcher).not.toHaveBeenCalled();
    const ok = await post("audio/ogg; codecs=opus", { "x-owner": "yes" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ text: "hola, nos vemos a las cinco" });
  });
});
