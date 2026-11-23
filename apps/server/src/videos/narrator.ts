import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wordsFromCharacters, type TimedWord } from "@jarvis/video/timeline";
import { encodeWav, toBytes, toSamples } from "../voice/pcm.js";
import { RoboticEffect } from "../voice/robotic-effect.js";
import { sanitizeForSpeech } from "../voice/sanitizer.js";

const SAMPLE_RATE = 24000;
const SEED = 1234;

export interface NarratorSettings {
  apiKey: string;
  voiceId: string;
  model: string;
  languageCode: string;
  effectIntensity: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** One narrated stretch, stored as a WAV with the real time of every word. */
export interface Narration {
  /** File name inside the cache directory. */
  file: string;
  path: string;
  durationMs: number;
  words: TimedWord[];
  characters: number;
  cached: boolean;
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface TimestampsResponse {
  audio_base64?: string;
  alignment?: Alignment | null;
}

/**
 * JARVIS's own voice for videos: the ElevenLabs voice of the calls through the with-timestamps
 * endpoint, with the same robotic touch. Audio is cached by text, voice, model and settings, so
 * a change of pictures or colors never pays for the narration again.
 */
export class Narrator {
  constructor(
    private readonly settings: NarratorSettings,
    private readonly cacheDir: string,
  ) {}

  get voiceId(): string {
    return this.settings.voiceId;
  }

  async narrate(text: string, signal?: AbortSignal): Promise<Narration> {
    const speech = sanitizeForSpeech(text);
    if (!speech) throw new Error("nothing to narrate");
    const key = this.key(speech);
    const file = `${key}.wav`;
    const path = join(this.cacheDir, file);
    const metaPath = join(this.cacheDir, `${key}.json`);
    if (existsSync(path) && existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { durationMs: number; words: TimedWord[] };
      return { file, path, ...meta, characters: speech.length, cached: true };
    }
    const response = await this.request(speech, signal);
    const alignment = response.alignment;
    if (!response.audio_base64 || !alignment?.characters.length) throw new Error("elevenlabs returned no audio or alignment");
    const samples = new RoboticEffect(SAMPLE_RATE, this.settings.effectIntensity).process(toSamples(Buffer.from(response.audio_base64, "base64")));
    const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
    const words = wordsFromCharacters(alignment.characters, alignment.character_start_times_seconds, alignment.character_end_times_seconds);
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, encodeWav(toBytes(samples), SAMPLE_RATE), { mode: 0o600 });
    writeFileSync(metaPath, JSON.stringify({ durationMs, words }), { mode: 0o600 });
    return { file, path, durationMs, words, characters: speech.length, cached: false };
  }

  private key(speech: string): string {
    const { voiceId, model, languageCode, effectIntensity } = this.settings;
    return createHash("sha256").update(JSON.stringify({ speech, voiceId, model, languageCode, effectIntensity, seed: SEED, rate: SAMPLE_RATE })).digest("hex").slice(0, 32);
  }

  private async request(text: string, signal?: AbortSignal): Promise<TimestampsResponse> {
    const { apiKey, voiceId, model, languageCode, baseUrl = "https://api.elevenlabs.io", timeoutMs = 60_000 } = this.settings;
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=pcm_${SAMPLE_RATE}`;
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const response = await (this.settings.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model, language_code: languageCode, seed: SEED }),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) throw new Error(`elevenlabs with-timestamps failed with status ${response.status}`);
    return (await response.json()) as TimestampsResponse;
  }
}
