import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./support/stack.js";
import { slowPiper, startStub, type StubServer } from "./support/stub-server.js";
import type { E2eClient } from "./support/ws-client.js";

const OUTPUT = { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 } as const;
const SENTENCES = 12;
const LONG_ANSWER = Array.from({ length: SENTENCES }, (_, i) => `Esta es la frase de prueba número ${i + 1}.`).join(" ");
const pause = (ms: number) => new Promise((resolveTick) => setTimeout(resolveTick, ms));

describe("interrupting a spoken reply on the real server", () => {
  let piper: StubServer;
  let stack: Stack;
  let client: E2eClient;
  let conversationId: string;
  let fullAudioBytes: number;

  const writes = (turnId: string) =>
    stack.rows<{ role: string }>("SELECT role FROM messages WHERE turn_id = ? ORDER BY rid", turnId).map((message) => message.role);

  const synthesisRequests = () => piper.requests.length;

  async function startSpeech(turnId: string, text = LONG_ANSWER): Promise<void> {
    client.sendText(conversationId, turnId, text, "voice");
    await client.waitFor("audio.begin", (event) => event.turnId === turnId);
  }

  beforeAll(async () => {
    piper = await startStub(slowPiper(250));
    stack = await Stack.create({ serverEnv: { TTS_PROVIDER: "piper", PIPER_URL: piper.url, PIPER_SAMPLE_RATE: "22050" } });
    await stack.startServer();
    client = await stack.connect();
    conversationId = (await client.hello([OUTPUT])).conversationId;

    const reference = crypto.randomUUID();
    client.sendText(conversationId, reference, LONG_ANSWER, "voice");
    await client.waitFor("turn.end", (event) => event.turnId === reference);
    fullAudioBytes = client.audioBytes(reference);
    expect(piper.requests).toHaveLength(SENTENCES);
  });

  afterAll(async () => {
    client.close();
    await stack.cleanup();
    await piper.stop();
  });

  it("stops synthesis and audio after turn.cancel and writes the turn exactly once", async () => {
    const turnId = crypto.randomUUID();
    const before = synthesisRequests();
    await startSpeech(turnId);
    client.send({ type: "turn.cancel", turnId, reason: "user_stop" });

    const end = await client.waitFor("turn.end", (event) => event.turnId === turnId);
    expect(end.status).toBe("cancelled");
    const audioEnd = await client.waitFor("audio.end", (event) => event.turnId === turnId);
    expect(audioEnd.reason).toBe("cancelled");

    const requestsAtCancel = synthesisRequests();
    const audioEndAt = client.indexOf((event) => event.type === "audio.end" && event.turnId === turnId);
    await pause(1_000);
    expect(synthesisRequests()).toBe(requestsAtCancel);
    expect(requestsAtCancel - before).toBeLessThan(SENTENCES);
    expect(client.timeline.slice(audioEndAt + 1).some((event) => event.type === "frame" && event.turnId === turnId)).toBe(false);
    expect(client.of("audio.end").filter((event) => event.turnId === turnId)).toHaveLength(1);
    expect(client.audioBytes(turnId)).toBeGreaterThan(0);
    expect(client.audioBytes(turnId)).toBeLessThan(fullAudioBytes / 2);

    expect(stack.rows<{ status: string }>("SELECT status FROM turns WHERE id = ?", turnId)[0]?.status).toBe("cancelled");
    expect(writes(turnId)).toEqual(["user", "assistant"]);
  });

  it("drops the old audio when the owner speaks again over it", async () => {
    const interrupted = crypto.randomUUID();
    const next = crypto.randomUUID();
    await startSpeech(interrupted);
    client.sendText(conversationId, next, "Hola.", "voice");

    const nextEnd = await client.waitFor("turn.end", (event) => event.turnId === next);
    expect(nextEnd.status).toBe("completed");
    const interruptedEnd = await client.waitFor("turn.end", (event) => event.turnId === interrupted);
    expect(interruptedEnd.status).toBe("cancelled");

    const oldAudioEnd = client.indexOf((event) => event.type === "audio.end" && event.turnId === interrupted);
    const newAudioBegin = client.indexOf((event) => event.type === "audio.begin" && event.turnId === next);
    expect(oldAudioEnd).toBeGreaterThanOrEqual(0);
    expect(newAudioBegin).toBeGreaterThan(oldAudioEnd);
    expect(client.timeline.slice(oldAudioEnd + 1).some((event) => event.type === "frame" && event.turnId === interrupted)).toBe(false);
    expect(client.audioBytes(next)).toBeGreaterThan(0);
    expect(client.audioBytes(interrupted)).toBeLessThan(fullAudioBytes / 2);

    expect(writes(interrupted)).toEqual(["user", "assistant"]);
    expect(writes(next)).toEqual(["user", "assistant"]);
    expect(stack.rows("SELECT id FROM turns WHERE id IN (?, ?)", interrupted, next)).toHaveLength(2);
  });
});
