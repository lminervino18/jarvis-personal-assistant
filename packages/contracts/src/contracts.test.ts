import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BinaryFrameKind,
  ClientMessage,
  MAX_TEXT_CHARS,
  ServerMessage,
  decodeAudioFrame,
  encodeAudioFrame,
  stateChangingTools,
  toolInputs,
  untrustedContentTools,
} from "./index.js";

describe("audio frames", () => {
  it("round-trips kind, turn id and payload", () => {
    const turnId = crypto.randomUUID();
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeAudioFrame(BinaryFrameKind.ttsAudio, turnId, payload);
    const decoded = decodeAudioFrame(frame);
    expect(decoded.kind).toBe(BinaryFrameKind.ttsAudio);
    expect(decoded.turnId).toBe(turnId);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 250]);
  });

  it("rejects truncated and unknown frames", () => {
    expect(() => decodeAudioFrame(new Uint8Array(5))).toThrow();
    const bad = encodeAudioFrame(BinaryFrameKind.micAudio, crypto.randomUUID(), new Uint8Array(1));
    bad[0] = 0x7f;
    expect(() => decodeAudioFrame(bad)).toThrow();
  });
});

describe("protocol", () => {
  it("accepts a valid text turn and rejects an empty one", () => {
    const base = { type: "user.text", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), replyMode: "text" };
    expect(ClientMessage.safeParse({ ...base, text: "¿Qué tengo mañana?" }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...base, text: "   " }).success).toBe(false);
  });

  it("takes a long pasted prompt, up to the limit", () => {
    const base = { type: "user.text", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), replyMode: "text" };
    expect(ClientMessage.safeParse({ ...base, text: "a".repeat(MAX_TEXT_CHARS) }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...base, text: "a".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: "build.request", text: "a".repeat(12_000) }).success).toBe(true);
  });

  it("does not let the server emit client-owned states", () => {
    expect(ServerMessage.safeParse({ type: "state", seq: 1, state: "thinking" }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "state", seq: 1, state: "listening" }).success).toBe(false);
  });
});

describe("activity events", () => {
  const base = {
    type: "activity",
    seq: 1,
    conversationId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    executionId: "toolu_1",
    tool: "gmail_search",
    phase: "running",
    version: 1,
    at: 1_700_000_000_000,
  };

  it("accepts an execution update without arguments or content", () => {
    expect(ServerMessage.safeParse(base).success).toBe(true);
    expect(ServerMessage.safeParse({ ...base, phase: "failed", errorCode: "upstream_error" }).success).toBe(true);
  });

  it("rejects unknown phases and invented progress", () => {
    expect(ServerMessage.safeParse({ ...base, phase: "almost" }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...base, progress: { done: 1, total: 0 } }).success).toBe(false);
  });
});

describe("tool contracts", () => {
  it("requires timezone offsets on reminder due dates", () => {
    const schema = z.object(toolInputs.reminders_create);
    expect(schema.safeParse({ text: "pagar la luz", dueAt: "2026-10-30T09:00:00-03:00" }).success).toBe(true);
    expect(schema.safeParse({ text: "pagar la luz", dueAt: "2026-10-30T09:00:00" }).success).toBe(false);
  });

  it("validates dates server side without repeating a date-time pattern in the JSON schema", () => {
    const json = JSON.stringify(z.toJSONSchema(z.object(toolInputs.calendar_list)));
    expect(json).not.toContain("pattern");
    expect(z.object(toolInputs.calendar_list).safeParse({ from: "2026-10-30", to: "2026-10-31T00:00:00-03:00" }).success).toBe(false);
  });

  it("never classifies an untrusted reader as a state changer", () => {
    for (const name of untrustedContentTools) expect(stateChangingTools.has(name)).toBe(false);
  });
});
