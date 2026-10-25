import { z } from "zod";
import { DEFAULT_ROBOTIC_INTENSITY, EngineTextToSpeech } from "./engine-tts.js";
import { ElevenLabsEngine, isElevenLabsRate } from "./elevenlabs-tts.js";
import { FixtureSpeechEngine, FixtureStt } from "./fixture-providers.js";
import { OpenAiCompatibleStt } from "./openai-stt.js";
import { PiperEngine } from "./piper-tts.js";
import { unavailableStt, unavailableTts, type SpeechToTextService, type TextToSpeechService } from "./types.js";

const VoiceEnvSchema = z.object({
  STT_PROVIDER: z.enum(["none", "fixture", "groq", "openai", "faster-whisper"]).default("none"),
  STT_MODEL: z.string().optional(),
  STT_BASE_URL: z.string().optional(),
  VOICE_LANGUAGE: z.string().default("es"),
  GROQ_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  FASTER_WHISPER_URL: z.string().optional(),
  TTS_PROVIDER: z.enum(["none", "fixture", "elevenlabs", "piper"]).default("none"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL: z.string().optional(),
  ELEVENLABS_SAMPLE_RATE: z.coerce.number().int().default(24000),
  PIPER_URL: z.string().optional(),
  PIPER_SAMPLE_RATE: z.coerce.number().int().default(22050),
  VOICE_ROBOTIC_INTENSITY: z.coerce.number().min(0).max(1).default(DEFAULT_ROBOTIC_INTENSITY),
});

type VoiceEnv = z.infer<typeof VoiceEnvSchema>;

export interface VoiceServices {
  stt: SpeechToTextService;
  tts: TextToSpeechService;
  warnings: string[];
}

export interface VoiceServiceOptions {
  allowFixtures: boolean;
}

/** Builds the configured providers; anything missing its settings stays unavailable so the app remains text-only. */
export function createVoiceServices(env: NodeJS.ProcessEnv, options: VoiceServiceOptions): VoiceServices {
  const parsed = VoiceEnvSchema.parse(env);
  const warnings: string[] = [];
  const stt = buildStt(parsed, options, warnings);
  const tts = buildTts(parsed, options, warnings);
  return { stt, tts, warnings };
}

function buildStt(env: VoiceEnv, options: VoiceServiceOptions, warnings: string[]): SpeechToTextService {
  switch (env.STT_PROVIDER) {
    case "none":
      return unavailableStt;
    case "fixture":
      if (!options.allowFixtures) return refuse("STT_PROVIDER=fixture is not allowed in production", warnings, unavailableStt);
      return new FixtureStt({ transcript: "Hola, ¿me escuchás?" });
    case "groq":
      if (!env.GROQ_API_KEY) return refuse("STT_PROVIDER=groq needs GROQ_API_KEY", warnings, unavailableStt);
      return openAiStt(env, "groq", env.STT_BASE_URL ?? "https://api.groq.com/openai/v1", "whisper-large-v3-turbo", env.GROQ_API_KEY);
    case "openai":
      if (!env.OPENAI_API_KEY) return refuse("STT_PROVIDER=openai needs OPENAI_API_KEY", warnings, unavailableStt);
      return openAiStt(env, "openai", env.STT_BASE_URL ?? "https://api.openai.com/v1", "gpt-4o-mini-transcribe", env.OPENAI_API_KEY);
    case "faster-whisper":
      if (!env.FASTER_WHISPER_URL) return refuse("STT_PROVIDER=faster-whisper needs FASTER_WHISPER_URL", warnings, unavailableStt);
      return openAiStt(env, "faster-whisper", env.FASTER_WHISPER_URL, "whisper", undefined);
  }
}

function openAiStt(env: VoiceEnv, provider: string, baseUrl: string, defaultModel: string, apiKey: string | undefined) {
  return new OpenAiCompatibleStt({ provider, baseUrl, apiKey, model: env.STT_MODEL ?? defaultModel, language: env.VOICE_LANGUAGE });
}

function buildTts(env: VoiceEnv, options: VoiceServiceOptions, warnings: string[]): TextToSpeechService {
  const effectIntensity = env.VOICE_ROBOTIC_INTENSITY;
  switch (env.TTS_PROVIDER) {
    case "none":
      return unavailableTts;
    case "fixture":
      if (!options.allowFixtures) return refuse("TTS_PROVIDER=fixture is not allowed in production", warnings, unavailableTts);
      return new EngineTextToSpeech({ provider: "fixture", engine: new FixtureSpeechEngine(), effectIntensity });
    case "elevenlabs": {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
        return refuse("TTS_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID", warnings, unavailableTts);
      }
      if (!isElevenLabsRate(env.ELEVENLABS_SAMPLE_RATE)) {
        return refuse("ELEVENLABS_SAMPLE_RATE must be 16000, 22050, 24000 or 44100", warnings, unavailableTts);
      }
      const engine = new ElevenLabsEngine({
        apiKey: env.ELEVENLABS_API_KEY,
        voiceId: env.ELEVENLABS_VOICE_ID,
        model: env.ELEVENLABS_MODEL,
        sampleRate: env.ELEVENLABS_SAMPLE_RATE,
        languageCode: env.VOICE_LANGUAGE,
      });
      return new EngineTextToSpeech({ provider: "elevenlabs", engine, effectIntensity });
    }
    case "piper": {
      if (!env.PIPER_URL) return refuse("TTS_PROVIDER=piper needs PIPER_URL", warnings, unavailableTts);
      const engine = new PiperEngine({ baseUrl: env.PIPER_URL, sampleRate: env.PIPER_SAMPLE_RATE });
      return new EngineTextToSpeech({ provider: "piper", engine, effectIntensity });
    }
  }
}

function refuse<T>(warning: string, warnings: string[], fallback: T): T {
  warnings.push(warning);
  return fallback;
}
