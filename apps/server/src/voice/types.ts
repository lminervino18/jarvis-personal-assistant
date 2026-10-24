import type { AudioFormat } from "@jarvis/contracts";

export interface TranscriptResult {
  text: string;
  provider: string;
  /** Wall time from finish() until the final transcript was available. */
  latencyMs: number;
  audioMs: number;
}

/** One capture of the owner's speech for one turn. */
export interface SpeechCapture {
  push(pcm: Uint8Array): void;
  finish(): Promise<TranscriptResult>;
  cancel(): void;
}

export interface SpeechToTextService {
  readonly provider: string;
  available(): boolean;
  startCapture(options: {
    turnId: string;
    format: AudioFormat;
    signal: AbortSignal;
    onPartial?: (text: string) => void;
  }): SpeechCapture;
}

/** Where synthesized audio goes: a WebSocket connection, a device, or a test buffer. */
export interface AudioSink {
  begin(format: AudioFormat, processed: boolean): void;
  /** Returns false when the transport is congested; wait for drain before writing more. */
  write(pcm: Uint8Array): boolean;
  waitForDrain(): Promise<void>;
  end(reason: "complete" | "cancelled" | "error"): void;
}

/** Speaks one assistant reply while its text streams in. */
export interface ReplySpeaker {
  textDelta(text: string): void;
  /** Called when the model starts a tool; text not yet spoken is provisional and dropped. */
  toolStarted(): void;
  /** Resolves when all speech was synthesized and written, or rejects on synthesis failure. */
  finish(): Promise<void>;
  cancel(): void;
  /** performance.now() timestamp of the first audio chunk written, if any. */
  readonly firstAudioAt: number | undefined;
}

export interface TextToSpeechService {
  readonly provider: string;
  available(): boolean;
  /** Picks the best output format among those the client can play, or null if none fits. */
  chooseOutputFormat(clientFormats: readonly AudioFormat[]): AudioFormat | null;
  createSpeaker(options: { turnId: string; output: AudioFormat; sink: AudioSink; signal: AbortSignal }): ReplySpeaker;
}

export const unavailableStt: SpeechToTextService = {
  provider: "none",
  available: () => false,
  startCapture() {
    throw new Error("speech-to-text is not configured");
  },
};

export const unavailableTts: TextToSpeechService = {
  provider: "none",
  available: () => false,
  chooseOutputFormat: () => null,
  createSpeaker() {
    throw new Error("text-to-speech is not configured");
  },
};
