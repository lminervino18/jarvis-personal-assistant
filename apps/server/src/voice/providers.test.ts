import { describe, expect, it } from "vitest";
import { ElevenLabsEngine } from "./elevenlabs-tts.js";
import { OpenAiCompatibleStt } from "./openai-stt.js";
import { decodeWav, encodeWav, toBytes, toSamples } from "./pcm.js";
import { PiperEngine } from "./piper-tts.js";
import { createVoiceServices } from "./providers.js";

const FORMAT_16K = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;
const idle = new AbortController();

function tone(sampleRate: number, seconds: number): Uint8Array {
  const samples = new Int16Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(5000 * Math.sin((2 * Math.PI * 300 * i) / sampleRate));
  return toBytes(samples);
}

async function collect(audio: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const part of audio) parts.push(part);
  return parts;
}

describe("OpenAiCompatibleStt", () => {
  function setup(respond: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    const stt = new OpenAiCompatibleStt({ provider: "groq", baseUrl: "https://stt.example/v1", model: "whisper-large-v3-turbo", apiKey: "secret-key", language: "es", fetch: fetcher });
    return { calls, stt };
  }

  it("uploads the captured turn as a WAV with model and language, and returns the transcript", async () => {
    const { calls, stt } = setup(() => Response.json({ text: "  ¿Qué hora es?  " }));
    const capture = stt.startCapture({ turnId: "t", format: FORMAT_16K, signal: idle.signal });
    const audio = tone(16000, 1);
    capture.push(audio.subarray(0, 10001));
    capture.push(audio.subarray(10001));
    const result = await capture.finish();
    expect(result).toMatchObject({ text: "¿Qué hora es?", provider: "groq", audioMs: 1000 });
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://stt.example/v1/audio/transcriptions");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    const form = call.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("es");
    const wav = decodeWav(new Uint8Array(await (form.get("file") as Blob).arrayBuffer()));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.pcm).toEqual(audio);
  });

  it("downsamples wideband captures to 16 kHz before uploading", async () => {
    const { calls, stt } = setup(() => Response.json({ text: "hola" }));
    const capture = stt.startCapture({ turnId: "t", format: { ...FORMAT_16K, sampleRate: 48000 }, signal: idle.signal });
    capture.push(tone(48000, 0.5));
    await capture.finish();
    const form = (calls[0] as { init: RequestInit }).init.body as FormData;
    const wav = decodeWav(new Uint8Array(await (form.get("file") as Blob).arrayBuffer()));
    expect(wav.sampleRate).toBe(16000);
    expect(Math.abs(toSamples(wav.pcm).length - 8000)).toBeLessThanOrEqual(2);
  });

  it("skips the request for captures too short to contain speech", async () => {
    const { calls, stt } = setup(() => Response.json({ text: "no" }));
    const capture = stt.startCapture({ turnId: "t", format: FORMAT_16K, signal: idle.signal });
    capture.push(tone(16000, 0.05));
    expect((await capture.finish()).text).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("fails without leaking the key when the provider rejects the request", async () => {
    const { stt } = setup(() => new Response("bad key secret-key", { status: 401 }));
    const capture = stt.startCapture({ turnId: "t", format: FORMAT_16K, signal: idle.signal });
    capture.push(tone(16000, 1));
    const error = await capture.finish().catch((reason: Error) => reason);
    expect((error as Error).message).toBe("groq transcription failed with status 401");
  });
});

describe("ElevenLabsEngine", () => {
  it("requests PCM at the configured rate and streams the body as aligned chunks", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const pcm = tone(24000, 0.2);
    const fetcher = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(pcm.subarray(0, 1001));
          controller.enqueue(pcm.subarray(1001));
          controller.close();
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const engine = new ElevenLabsEngine({ apiKey: "k", voiceId: "voice 1", languageCode: "es", fetch: fetcher });
    const parts = await collect(engine.synthesize("Hola Loren.", { signal: idle.signal, previousText: "Buen día." }));
    expect(parts.reduce((sum, part) => sum + part.byteLength, 0)).toBe(pcm.byteLength);
    const request = captured as { url: string; init: RequestInit };
    expect(request.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%201/stream?output_format=pcm_24000");
    expect((request.init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
    expect(JSON.parse(request.init.body as string)).toEqual({ text: "Hola Loren.", model_id: "eleven_flash_v2_5", language_code: "es", previous_text: "Buen día." });
    expect(engine.sampleRate).toBe(24000);
  });

  it("throws on provider errors", async () => {
    const fetcher = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    const engine = new ElevenLabsEngine({ apiKey: "k", voiceId: "v", fetch: fetcher });
    await expect(collect(engine.synthesize("Hola.", { signal: idle.signal, previousText: undefined }))).rejects.toThrow("status 429");
  });
});

describe("PiperEngine", () => {
  it("posts the sentence, strips the WAV header and slices the PCM", async () => {
    const pcm = tone(22050, 0.35);
    let captured: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(encodeWav(pcm, 22050));
    }) as unknown as typeof fetch;
    const engine = new PiperEngine({ baseUrl: "http://piper:5000", fetch: fetcher });
    const parts = await collect(engine.synthesize("Hola Loren.", { signal: idle.signal, previousText: undefined }));
    expect(parts.length).toBeGreaterThan(1);
    expect(Uint8Array.from(parts.flatMap((part) => [...part]))).toEqual(pcm);
    const request = captured as { url: string; init: RequestInit };
    expect(request.url).toBe("http://piper:5000/synthesize");
    expect(JSON.parse(request.init.body as string)).toEqual({ text: "Hola Loren." });
  });

  it("refuses a voice whose rate differs from the configured one", async () => {
    const fetcher = (async () => new Response(encodeWav(tone(16000, 0.1), 16000))) as unknown as typeof fetch;
    const engine = new PiperEngine({ baseUrl: "http://piper:5000", fetch: fetcher });
    await expect(collect(engine.synthesize("Hola.", { signal: idle.signal, previousText: undefined }))).rejects.toThrow("16000 Hz");
  });
});

describe("createVoiceServices", () => {
  const options = { allowFixtures: true };

  it("stays text-only by default", () => {
    const { stt, tts, warnings } = createVoiceServices({}, options);
    expect([stt.available(), tts.available(), warnings]).toEqual([false, false, []]);
  });

  it("builds fixture, Groq, ElevenLabs and Piper providers from the environment", () => {
    expect(createVoiceServices({ STT_PROVIDER: "fixture", TTS_PROVIDER: "fixture" }, options)).toMatchObject({ stt: { provider: "fixture" }, tts: { provider: "fixture" } });
    expect(createVoiceServices({ STT_PROVIDER: "groq", GROQ_API_KEY: "k" }, options).stt.provider).toBe("groq");
    expect(createVoiceServices({ STT_PROVIDER: "faster-whisper", FASTER_WHISPER_URL: "http://fw:8000/v1" }, options).stt.provider).toBe("faster-whisper");
    expect(createVoiceServices({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" }, options).tts.provider).toBe("elevenlabs");
    expect(createVoiceServices({ TTS_PROVIDER: "piper", PIPER_URL: "http://piper:5000" }, options).tts.provider).toBe("piper");
  });

  it("falls back to unavailable with a warning when settings are missing or fixtures are forbidden", () => {
    const missing = createVoiceServices({ STT_PROVIDER: "groq", TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" }, options);
    expect([missing.stt.available(), missing.tts.available(), missing.warnings]).toEqual([
      false,
      false,
      ["STT_PROVIDER=groq needs GROQ_API_KEY", "TTS_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID"],
    ]);
    const production = createVoiceServices({ STT_PROVIDER: "fixture", TTS_PROVIDER: "fixture" }, { allowFixtures: false });
    expect([production.stt.available(), production.tts.available(), production.warnings]).toEqual([
      false,
      false,
      ["STT_PROVIDER=fixture is not allowed in production", "TTS_PROVIDER=fixture is not allowed in production"],
    ]);
  });

  it("rejects an invalid provider name or intensity", () => {
    expect(() => createVoiceServices({ TTS_PROVIDER: "azure" }, options)).toThrow();
    expect(() => createVoiceServices({ VOICE_ROBOTIC_INTENSITY: "3" }, options)).toThrow();
  });
});
