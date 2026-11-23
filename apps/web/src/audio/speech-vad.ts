import type { VadDecision } from "./vad.js";

export interface SpeechVadOptions {
  frameMs: number;
  /** Probability that starts (or resumes) speech. */
  startProbability: number;
  /** Probability that keeps an utterance going (hysteresis). */
  stopProbability: number;
  /** Voiced time needed before a candidate becomes speech. */
  minSpeechMs: number;
  /** Silence inside a candidate that discards it as a blip. */
  candidateGapMs: number;
  /** Silence after speech that reports a pause; the server decides whether the turn ended. */
  pauseMs: number;
  /** Voiced time after a pause that reports the owner kept talking. */
  resumeMs: number;
  /** Silence that ends the utterance here if the server never decided (safety net). */
  endSilenceMs: number;
  maxUtteranceMs: number;
}

export const speechVadOptions: SpeechVadOptions = {
  frameMs: 20,
  startProbability: 0.5,
  stopProbability: 0.35,
  minSpeechMs: 200,
  candidateGapMs: 100,
  pauseMs: 450,
  resumeMs: 100,
  endSilenceMs: 3500,
  maxUtteranceMs: 115_000,
};

/** Stricter start while the assistant speaks, so a click or residual echo does not open a candidate. */
export const playbackSpeechVadOptions: SpeechVadOptions = { ...speechVadOptions, startProbability: 0.6, minSpeechMs: 250 };

export type SpeechDecision = VadDecision | "pause" | "resume";

/**
 * Turns per-frame speech probabilities (Silero) into utterance events. Unlike a volume threshold it
 * reports pauses instead of ending the turn, so the server can decide with the words whether the
 * owner finished; "end" is only a safety net for a long silence.
 */
export class SpeechVad {
  private phase: "idle" | "pending" | "speech" = "idle";
  private voicedMs = 0;
  private gapMs = 0;
  private utteranceMs = 0;
  private paused = false;
  private resumeRunMs = 0;
  private totalVoicedMs = 0;

  constructor(private readonly options: SpeechVadOptions = speechVadOptions) {}

  /** Voiced time inside the current utterance, pauses excluded. */
  get voicedTotalMs(): number {
    return this.totalVoicedMs;
  }

  reset(): void {
    this.phase = "idle";
    this.voicedMs = 0;
    this.gapMs = 0;
    this.utteranceMs = 0;
    this.paused = false;
    this.resumeRunMs = 0;
    this.totalVoicedMs = 0;
  }

  push(probability: number): SpeechDecision {
    switch (this.phase) {
      case "idle":
        return this.onIdle(probability);
      case "pending":
        return this.onPending(probability);
      case "speech":
        return this.onSpeech(probability);
    }
  }

  private onIdle(probability: number): SpeechDecision {
    if (probability < this.options.startProbability) return "idle";
    this.phase = "pending";
    this.voicedMs = this.options.frameMs;
    this.gapMs = 0;
    return this.confirmIfLongEnough();
  }

  private onPending(probability: number): SpeechDecision {
    if (probability >= this.options.stopProbability) {
      this.voicedMs += this.options.frameMs;
      this.gapMs = 0;
      return this.confirmIfLongEnough();
    }
    this.gapMs += this.options.frameMs;
    if (this.gapMs >= this.options.candidateGapMs) this.reset();
    return this.phase === "idle" ? "idle" : "pending";
  }

  private onSpeech(probability: number): SpeechDecision {
    const { frameMs, pauseMs, endSilenceMs, maxUtteranceMs, resumeMs, startProbability, stopProbability } = this.options;
    this.utteranceMs += frameMs;
    if (this.utteranceMs >= maxUtteranceMs) {
      this.reset();
      return "end";
    }
    if (this.paused) {
      this.resumeRunMs = probability >= startProbability ? this.resumeRunMs + frameMs : 0;
      if (this.resumeRunMs >= resumeMs) {
        this.paused = false;
        this.gapMs = 0;
        this.totalVoicedMs += this.resumeRunMs;
        this.resumeRunMs = 0;
        return "resume";
      }
      this.gapMs += frameMs;
      if (this.gapMs >= endSilenceMs) {
        this.reset();
        return "end";
      }
      return "speech";
    }
    if (probability >= stopProbability) {
      this.gapMs = 0;
      this.totalVoicedMs += frameMs;
      return "speech";
    }
    this.gapMs += frameMs;
    if (this.gapMs >= pauseMs) {
      this.paused = true;
      this.resumeRunMs = 0;
      return "pause";
    }
    return "speech";
  }

  private confirmIfLongEnough(): SpeechDecision {
    if (this.voicedMs < this.options.minSpeechMs) return "pending";
    this.phase = "speech";
    this.utteranceMs = this.voicedMs;
    this.totalVoicedMs = this.voicedMs;
    this.gapMs = 0;
    return "start";
  }
}
