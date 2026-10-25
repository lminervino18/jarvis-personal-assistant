import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BinaryFrameKind } from "@jarvis/contracts";
import { Stack } from "./support/stack.js";
import type { E2eClient } from "./support/ws-client.js";

const OUTPUT_FORMATS = [
  { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
] as const;

interface TurnRow {
  id: string;
  input_mode: string;
  reply_mode: string;
  status: string;
  claude_session_id: string;
  stt_ms: number | null;
  first_audio_ms: number | null;
}

interface MessageRow {
  turn_id: string;
  role: string;
  content: string;
}

describe("spoken and typed conversation on the real server", () => {
  let stack: Stack;
  let client: E2eClient;
  let conversationId: string;

  beforeAll(async () => {
    stack = await Stack.create();
    await stack.startServer();
    client = await stack.connect();
    const ready = await client.hello([...OUTPUT_FORMATS]);
    conversationId = ready.conversationId;
    expect(ready.capabilities).toMatchObject({ stt: true, tts: true, ttsProvider: "fixture" });
  });

  afterAll(async () => {
    client.close();
    await stack.cleanup();
  });

  it("answers a spoken query with a transcript, text and audio tagged with the turn id", async () => {
    const turnId = crypto.randomUUID();
    client.speak(conversationId, turnId);
    await client.waitFor("turn.end", (event) => event.turnId === turnId);

    const transcript = client.of("transcript").find((event) => event.turnId === turnId && event.final);
    expect(transcript?.text).toBe("Hola, ¿me escuchás?");
    const done = client.of("assistant.done").find((event) => event.turnId === turnId);
    expect(done).toMatchObject({ text: "Recibido: Hola, ¿me escuchás?", interrupted: false });

    const begin = client.of("audio.begin").find((event) => event.turnId === turnId);
    expect(begin?.format).toEqual({ encoding: "pcm_s16le", sampleRate: 24000, channels: 1 });
    const frames = client.frames(turnId);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.kind === BinaryFrameKind.ttsAudio && frame.payload.byteLength % 2 === 0)).toBe(true);
    const samples = new Int16Array(frames[0]!.payload.slice().buffer);
    expect(samples.some((sample) => Math.abs(sample) > 500)).toBe(true);
    const end = client.of("audio.end").find((event) => event.turnId === turnId);
    expect(end?.reason).toBe("complete");

    const positions = [
      client.indexOf((event) => event.type === "transcript" && event.turnId === turnId && event.final),
      client.indexOf((event) => event.type === "assistant.done" && event.turnId === turnId),
      client.indexOf((event) => event.type === "audio.begin" && event.turnId === turnId),
      client.indexOf((event) => event.type === "frame" && event.turnId === turnId),
      client.indexOf((event) => event.type === "audio.end" && event.turnId === turnId),
      client.indexOf((event) => event.type === "turn.end" && event.turnId === turnId),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));

    const turn = stack.rows<TurnRow>("SELECT * FROM turns WHERE id = ?", turnId)[0];
    expect(turn).toMatchObject({ input_mode: "voice", reply_mode: "voice", status: "completed" });
    expect(turn?.stt_ms).not.toBeNull();
    expect(turn?.first_audio_ms).not.toBeNull();
    const messages = stack.rows<MessageRow>("SELECT turn_id, role, content FROM messages WHERE turn_id = ? ORDER BY rid", turnId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("resumes the same Claude session for the follow-up question in the same conversation", async () => {
    const first = crypto.randomUUID();
    const followUp = crypto.randomUUID();
    client.sendText(conversationId, first, "¿Qué clima hace hoy en Buenos Aires?");
    await client.waitFor("turn.end", (event) => event.turnId === first);
    client.sendText(conversationId, followUp, "¿y mañana?");
    const end = await client.waitFor("turn.end", (event) => event.turnId === followUp);
    expect(end.status).toBe("completed");

    const turns = stack.rows<TurnRow>("SELECT * FROM turns WHERE id IN (?, ?)", first, followUp);
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((turn) => turn.claude_session_id)).size).toBe(1);
    const conversation = stack.rows<{ claude_session_id: string; session_turns: number }>(
      "SELECT claude_session_id, session_turns FROM conversations WHERE id = ?",
      conversationId,
    )[0];
    expect(conversation?.claude_session_id).toBe(turns[0]?.claude_session_id);
    expect(conversation?.session_turns).toBe(3);
    expect(stack.rows("SELECT id FROM conversations")).toHaveLength(1);
  });

  it("restores the conversation on reconnect without duplicating messages or turns", async () => {
    const before = stack.rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages")[0]?.n;
    client.close();

    const reconnected = await stack.connect();
    const ready = await reconnected.hello([...OUTPUT_FORMATS], conversationId);
    expect(ready.conversationId).toBe(conversationId);
    const history = await reconnected.waitFor("history");
    const ids = history?.items.map((item) => item.id) ?? [];
    expect(ids).toHaveLength(before ?? -1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(history?.items.map((item) => item.text)).toContain("¿y mañana?");

    const turnId = crypto.randomUUID();
    reconnected.sendText(conversationId, turnId, "¿y pasado mañana?");
    await reconnected.waitFor("turn.end", (event) => event.turnId === turnId);
    expect(stack.rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages")[0]?.n).toBe((before ?? 0) + 2);
    expect(stack.rows<{ session_turns: number }>("SELECT session_turns FROM conversations WHERE id = ?", conversationId)[0]?.session_turns).toBe(4);
    reconnected.close();
  });

  it("does not duplicate writes when a client re-sends a turn id", async () => {
    const retry = await stack.connect();
    const { conversationId: id } = await retry.hello([...OUTPUT_FORMATS], conversationId);
    const turnId = crypto.randomUUID();
    retry.sendText(id, turnId, "mensaje reenviado");
    await retry.waitFor("turn.end", (event) => event.turnId === turnId);
    const count = () => stack.rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '%mensaje reenviado%'")[0]?.n;
    const written = count();
    retry.sendText(id, turnId, "mensaje reenviado");
    await new Promise((resolveTick) => setTimeout(resolveTick, 500));
    expect(count()).toBe(written);
    expect(stack.rows("SELECT id FROM turns WHERE id = ?", turnId)).toHaveLength(1);
    retry.close();
  });

  it("never writes message bodies to the process logs", () => {
    for (const secret of ["Hola, ¿me escuchás?", "¿Qué clima hace hoy", "¿y mañana?", "Recibido:"]) {
      expect(stack.logs).not.toContain(secret);
    }
    expect(stack.logs).toContain("voice providers loaded");
  });
});
