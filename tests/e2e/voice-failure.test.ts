import { afterEach, describe, expect, it } from "vitest";
import { Stack } from "./support/stack.js";
import { failing, startStub, type StubServer } from "./support/stub-server.js";

const OUTPUT = { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 } as const;

describe("voice providers failing on the real server", () => {
  const stubs: StubServer[] = [];
  const stacks: Stack[] = [];

  afterEach(async () => {
    await Promise.all(stacks.splice(0).map((stack) => stack.cleanup()));
    await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
  });

  async function start(serverEnv: Record<string, string>) {
    const stack = await Stack.create({ serverEnv });
    stacks.push(stack);
    await stack.startServer();
    const client = await stack.connect();
    const ready = await client.hello([OUTPUT]);
    return { stack, client, conversationId: ready.conversationId, ready };
  }

  async function failingProvider(): Promise<StubServer> {
    const stub = await startStub(failing);
    stubs.push(stub);
    return stub;
  }

  it("keeps the written answer when text-to-speech breaks", async () => {
    const piper = await failingProvider();
    const { stack, client, conversationId } = await start({ TTS_PROVIDER: "piper", PIPER_URL: piper.url });
    const turnId = crypto.randomUUID();
    client.sendText(conversationId, turnId, "Decime la hora.", "voice");

    const done = await client.waitFor("assistant.done", (event) => event.turnId === turnId);
    expect(done.text).toBe("Recibido: Decime la hora.");
    const error = await client.waitFor("error", (event) => event.turnId === turnId);
    expect(error).toMatchObject({ code: "tts_failed", retryable: true });
    expect(error.message).toContain("quedó por escrito");
    expect(client.of("audio.begin")).toHaveLength(0);
    expect(client.audioBytes(turnId)).toBe(0);
    expect(piper.requests.length).toBeGreaterThan(0);

    const messages = stack.rows<{ role: string; content: string }>("SELECT role, content FROM messages WHERE turn_id = ? ORDER BY rid", turnId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("asks the owner to retry or type when speech-to-text breaks, then keeps working", async () => {
    const whisper = await failingProvider();
    const { stack, client, conversationId } = await start({ STT_PROVIDER: "faster-whisper", FASTER_WHISPER_URL: whisper.url });
    const turnId = crypto.randomUUID();
    client.speak(conversationId, turnId);

    const error = await client.waitFor("error", (event) => event.turnId === turnId);
    expect(error).toMatchObject({ code: "stt_failed", retryable: true });
    expect(error.message).toContain("escribime");
    expect(whisper.requests.length).toBeGreaterThan(0);
    expect(stack.rows("SELECT id FROM turns WHERE id = ?", turnId)).toHaveLength(0);
    expect(stack.rows("SELECT id FROM messages")).toHaveLength(0);

    const typed = crypto.randomUUID();
    client.sendText(conversationId, typed, "Entonces te escribo.");
    expect((await client.waitFor("turn.end", (event) => event.turnId === typed)).status).toBe("completed");
  });

  it("answers by text with a notice when no text-to-speech provider is configured", async () => {
    const { client, conversationId, ready } = await start({ TTS_PROVIDER: "none" });
    expect(ready.capabilities.tts).toBe(false);
    const turnId = crypto.randomUUID();
    client.sendText(conversationId, turnId, "Hablame.", "voice");

    const notice = await client.waitFor("notice", (event) => event.code === "tts_unavailable");
    expect(notice.message).toContain("respondo por texto");
    const done = await client.waitFor("assistant.done", (event) => event.turnId === turnId);
    expect(done.text).toBe("Recibido: Hablame.");
    expect(client.of("audio.begin")).toHaveLength(0);
  });
});
