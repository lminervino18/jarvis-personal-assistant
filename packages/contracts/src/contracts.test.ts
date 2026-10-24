import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BinaryFrameKind,
  ClientMessage,
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

  it("does not let the server emit client-owned states", () => {
    expect(ServerMessage.safeParse({ type: "state", seq: 1, state: "thinking" }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "state", seq: 1, state: "listening" }).success).toBe(false);
  });
});

describe("tool contracts", () => {
  it("requires timezone offsets on reminder due dates", () => {
    const schema = z.object(toolInputs.reminders_create);
    expect(schema.safeParse({ text: "pagar la luz", dueAt: "2026-10-30T09:00:00-03:00" }).success).toBe(true);
    expect(schema.safeParse({ text: "pagar la luz", dueAt: "2026-10-30T09:00:00" }).success).toBe(false);
  });

  it("never classifies an untrusted reader as a state changer", () => {
    for (const name of untrustedContentTools) expect(stateChangingTools.has(name)).toBe(false);
  });
});
