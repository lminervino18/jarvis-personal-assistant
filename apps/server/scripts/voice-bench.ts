import { readFileSync } from "node:fs";
import type { AudioFormat } from "@jarvis/contracts";
import Database from "better-sqlite3";
import { summarize, type LatencySummary } from "../src/voice/latency.js";
import { decodeWav, pcmDurationMs, resample, toBytes, toSamples } from "../src/voice/pcm.js";
import { createVoiceServices } from "../src/voice/providers.js";
import type { AudioSink, SpeechToTextService, TextToSpeechService } from "../src/voice/types.js";

const SAMPLE_REPLIES = [
  "Listo, Loren. Tenés una reunión a las diez y otra a las tres de la tarde.",
  "Mañana hace veintidós grados con algunas nubes, así que no hace falta llevar abrigo. Si querés, te aviso a la mañana por si cambia.",
  "Revisé tu correo: hay dos mensajes nuevos, uno de tu contador y otro del banco. El primero parece urgente.",
];
const MIC_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };
const OUTPUT_RATES = [24000, 22050, 16000] as const;

const args = parseArgs(process.argv.slice(2));
const runs = Number(args.get("runs") ?? 5);
const configured = createVoiceServices(process.env, { allowFixtures: true });
const fixtures = createVoiceServices({ STT_PROVIDER: "fixture", TTS_PROVIDER: "fixture" }, { allowFixtures: true });
for (const warning of configured.warnings) console.error(`warning: ${warning}`);

const liveStt = configured.stt.available();
const liveTts = configured.tts.available();
const services = { stt: liveStt ? configured.stt : fixtures.stt, tts: liveTts ? configured.tts : fixtures.tts };

const ttsResult = await benchTts(services.tts, runs);
const sampleSpeech = args.get("wav") ? loadWav(args.get("wav") as string) : ttsResult.sample;
const sttResult = await benchStt(services.stt, sampleSpeech, runs);

console.log(JSON.stringify({ stt: sttResult, tts: ttsResult.summary }, null, 2));
console.log(
  [
    `STT provider=${services.stt.provider} (${liveStt ? "live" : "fixture only: not a real latency"}) finish->transcript ms: ${format(sttResult.latencyMs)}`,
    `TTS provider=${services.tts.provider} (${liveTts ? "live" : "fixture only: not a real latency"}) text->first audio ms: ${format(ttsResult.summary.firstAudioMs)}`,
    `TTS real-time factor (synthesis time / audio time): ${ttsResult.summary.realTimeFactor.toFixed(2)}`,
  ].join("\n"),
);

if (args.get("db")) reportTurns(args.get("db") as string);

async function benchStt(service: SpeechToTextService, speech: Uint8Array, count: number) {
  const latencies: number[] = [];
  let text = "";
  for (let i = 0; i < count; i++) {
    const capture = service.startCapture({ turnId: crypto.randomUUID(), format: MIC_FORMAT, signal: new AbortController().signal });
    capture.push(speech);
    const result = await capture.finish();
    latencies.push(result.latencyMs);
    text = result.text;
  }
  return { provider: service.provider, audioMs: pcmDurationMs(speech.byteLength, MIC_FORMAT.sampleRate), transcriptChars: text.length, latencyMs: summarize(latencies) };
}

async function benchTts(service: TextToSpeechService, count: number) {
  const output = service.chooseOutputFormat(OUTPUT_RATES.map((sampleRate) => ({ ...MIC_FORMAT, sampleRate })));
  if (!output) throw new Error("text-to-speech offers no output format");
  const firstAudio: number[] = [];
  let synthesisMs = 0;
  let audioMs = 0;
  let sample: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const text = SAMPLE_REPLIES[i % SAMPLE_REPLIES.length] as string;
    const recorder = recordingSink(output);
    const speaker = service.createSpeaker({ turnId: crypto.randomUUID(), output, sink: recorder.sink, signal: new AbortController().signal });
    const startedAt = performance.now();
    speaker.textDelta(text);
    await speaker.finish();
    synthesisMs += performance.now() - startedAt;
    audioMs += pcmDurationMs(recorder.bytes(), output.sampleRate);
    firstAudio.push((speaker.firstAudioAt ?? performance.now()) - startedAt);
    if (i === 0) sample = toBytes(resample(toSamples(recorder.pcm()), output.sampleRate, MIC_FORMAT.sampleRate));
  }
  const summary = { provider: service.provider, outputRate: output.sampleRate, replyChars: SAMPLE_REPLIES.map((reply) => reply.length), firstAudioMs: summarize(firstAudio), realTimeFactor: synthesisMs / audioMs };
  return { summary, sample };
}

function recordingSink(_format: AudioFormat) {
  const parts: Uint8Array[] = [];
  const sink: AudioSink = {
    begin: () => {},
    write: (pcm) => {
      parts.push(pcm.slice());
      return true;
    },
    waitForDrain: async () => {},
    end: () => {},
  };
  const pcm = () => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  };
  return { sink, pcm, bytes: () => pcm().byteLength };
}

function loadWav(path: string): Uint8Array {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  return toBytes(resample(toSamples(wav.pcm), wav.sampleRate, MIC_FORMAT.sampleRate));
}

function reportTurns(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT used_tools, stt_ms, first_text_ms, first_audio_ms, client_first_audio_ms FROM turns WHERE input_mode = 'voice' AND status = 'completed'").all() as Record<string, number | null>[];
  for (const [label, usedTools] of [["simple turns", 0], ["tool turns", 1]] as const) {
    const group = rows.filter((row) => row.used_tools === usedTools);
    console.log(`\n${label} (${group.length} voice turns)`);
    for (const column of ["stt_ms", "first_text_ms", "first_audio_ms", "client_first_audio_ms"]) {
      const values = group.map((row) => row[column]).filter((value): value is number => value !== null);
      console.log(`  ${column}: ${format(summarize(values))}`);
    }
  }
  db.close();
}

function format(summary: LatencySummary | undefined): string {
  return summary ? `p50=${summary.p50.toFixed(0)} p95=${summary.p95.toFixed(0)} max=${summary.max.toFixed(0)} n=${summary.count}` : "no data";
}

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) parsed.set((argv[i] as string).replace(/^--/, ""), argv[i + 1] ?? "");
  return parsed;
}
