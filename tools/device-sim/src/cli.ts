import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DEVICE_AUDIO_FORMAT, DeviceSimulator } from "./simulator.js";
import { encodeWav, parseWav, toneAudio } from "./wav.js";

const USAGE = `Usage: JARVIS_DEVICE_TOKEN=<token> pnpm --filter @jarvis/device-sim start -- --url wss://host/ws/device (--wav in.wav | --tone <seconds>) [options]

  --out <file>            write the reply as a 16 kHz WAV (default: reply.wav)
  --realtime              pace the microphone frames at their real duration
  --cancel-after-ms <ms>  cancel the turn after this long
  --insecure              allow ws:// to a non-local host
`;

const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));

const { values } = parseArgs({
  args,
  options: {
    url: { type: "string" },
    wav: { type: "string" },
    tone: { type: "string" },
    out: { type: "string", default: "reply.wav" },
    realtime: { type: "boolean", default: false },
    "cancel-after-ms": { type: "string" },
    insecure: { type: "boolean", default: false },
  },
});

const token = process.env.JARVIS_DEVICE_TOKEN;
if (!values.url || !token || !(values.wav || values.tone)) {
  console.error(USAGE);
  process.exit(2);
}

async function loadMicrophone(): Promise<Uint8Array> {
  if (values.tone) return toneAudio(Number(values.tone), DEVICE_AUDIO_FORMAT.sampleRate);
  const wav = parseWav(await readFile(values.wav as string));
  if (wav.sampleRate !== DEVICE_AUDIO_FORMAT.sampleRate) throw new Error(`the WAV must be ${DEVICE_AUDIO_FORMAT.sampleRate} Hz mono (got ${wav.sampleRate} Hz)`);
  return wav.pcm;
}

const simulator = new DeviceSimulator({
  url: values.url,
  token,
  allowInsecure: values.insecure,
  realtime: values.realtime,
  log: (line) => console.error(`[device-sim] ${line}`),
});

const microphone = await loadMicrophone();
try {
  await simulator.connect();
} catch (error) {
  console.error(`[device-sim] could not connect: ${error instanceof Error ? error.message : "unknown error"}`);
  simulator.close();
  process.exit(1);
}
const turn = simulator.speak(microphone);
if (values["cancel-after-ms"]) setTimeout(() => simulator.cancel(), Number(values["cancel-after-ms"]));
const result = await turn.done;
simulator.close();

if (result.reply.byteLength > 0 && result.replyFormat) {
  await writeFile(values.out, encodeWav(result.reply, result.replyFormat.sampleRate));
}
console.log(
  JSON.stringify({
    status: result.status,
    errorCode: result.errorCode,
    transcript: result.transcript,
    assistantText: result.assistantText,
    replyBytes: result.reply.byteLength,
    replyTruncated: result.replyTruncated,
    droppedFrames: simulator.stats.droppedFrames,
  }),
);
process.exit(result.status === "completed" || (result.status === "cancelled" && values["cancel-after-ms"]) ? 0 : 1);
