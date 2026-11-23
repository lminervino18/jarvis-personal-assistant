import { MAX_ATTACHMENT_BYTES } from "../attachments/attachment-store.js";

export const MAX_AUDIO_BYTES = MAX_ATTACHMENT_BYTES;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export type AudioTranscriptionError = "unsupported_type" | "empty_file" | "file_too_large" | "stt_unavailable" | "transcription_failed";

export type AudioTranscriptionResult = { ok: true; text: string } | { ok: false; error: AudioTranscriptionError };

export interface AudioFileTranscriber {
  transcribeFile(file: { data: Uint8Array; mediaType: string; fileName: string }, signal?: AbortSignal): Promise<string>;
}

export function normalizeAudioType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

export async function transcribeAudioFile(
  stt: AudioFileTranscriber | undefined,
  input: { data: Uint8Array; mediaType: string },
  signal?: AbortSignal,
): Promise<AudioTranscriptionResult> {
  const mediaType = normalizeAudioType(input.mediaType);
  const extension = EXTENSIONS[mediaType];
  if (!extension) return { ok: false, error: "unsupported_type" };
  if (input.data.byteLength === 0) return { ok: false, error: "empty_file" };
  if (input.data.byteLength > MAX_AUDIO_BYTES) return { ok: false, error: "file_too_large" };
  if (!stt) return { ok: false, error: "stt_unavailable" };
  try {
    return { ok: true, text: await stt.transcribeFile({ data: input.data, mediaType, fileName: `audio.${extension}` }, signal) };
  } catch {
    return { ok: false, error: "transcription_failed" };
  }
}
