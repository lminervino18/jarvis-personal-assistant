import { z } from "zod";

/**
 * Audio travels as raw little-endian 16-bit PCM, mono. Browser and ESP32 negotiate the
 * sample rate they can capture and play; the server resamples when needed.
 */
export const AudioFormat = z.object({
  encoding: z.literal("pcm_s16le"),
  sampleRate: z.union([
    z.literal(8000),
    z.literal(16000),
    z.literal(22050),
    z.literal(24000),
    z.literal(44100),
    z.literal(48000),
  ]),
  channels: z.literal(1),
});
export type AudioFormat = z.infer<typeof AudioFormat>;

export const STT_INPUT_FORMAT: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

export const BinaryFrameKind = {
  micAudio: 0x01,
  ttsAudio: 0x02,
} as const;
export type BinaryFrameKind = (typeof BinaryFrameKind)[keyof typeof BinaryFrameKind];

const HEADER_BYTES = 17;

/**
 * Binary WebSocket frame: [kind:1][turnId as 16 raw UUID bytes][payload].
 * The turn id lets both sides drop audio that belongs to a cancelled or stale turn.
 */
export function encodeAudioFrame(kind: BinaryFrameKind, turnId: string, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = kind;
  frame.set(uuidToBytes(turnId), 1);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export interface DecodedAudioFrame {
  kind: BinaryFrameKind;
  turnId: string;
  payload: Uint8Array;
}

export function decodeAudioFrame(frame: Uint8Array): DecodedAudioFrame {
  if (frame.byteLength < HEADER_BYTES) throw new Error("audio frame too short");
  const kind = frame[0];
  if (kind !== BinaryFrameKind.micAudio && kind !== BinaryFrameKind.ttsAudio) {
    throw new Error(`unknown audio frame kind ${String(kind)}`);
  }
  return {
    kind,
    turnId: bytesToUuid(frame.subarray(1, HEADER_BYTES)),
    payload: frame.subarray(HEADER_BYTES),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) throw new Error("invalid uuid");
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error("uuid must be 16 bytes");
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
