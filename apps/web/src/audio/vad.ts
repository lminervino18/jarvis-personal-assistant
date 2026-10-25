export interface VadOptions {
  frameMs: number;
  /** Speech starts when the level rises this far above the noise floor. */
  startMarginDb: number;
  /** Speech continues while the level stays this far above the noise floor (hysteresis). */
  stopMarginDb: number;
  /** The start threshold never drops below this absolute level. */
  minStartDbfs: number;
  /** Voiced time needed before a candidate becomes speech. */
  minSpeechMs: number;
  /** Silence inside a candidate that discards it as a blip. */
  candidateGapMs: number;
  /** Silence after speech that ends the turn. */
  endSilenceMs: number;
  maxUtteranceMs: number;
  initialFloorDbfs: number;
  /** Time at the start spent only measuring the room, so loud rooms do not read as speech. */
  warmupMs: number;
}

export const defaultVadOptions: VadOptions = {
  frameMs: 20,
  startMarginDb: 14,
  stopMarginDb: 8,
  minStartDbfs: -52,
  minSpeechMs: 160,
  candidateGapMs: 120,
  endSilenceMs: 900,
  maxUtteranceMs: 30_000,
  initialFloorDbfs: -65,
  warmupMs: 300,
};

/** Stricter settings used while the assistant speaks, so its own echo does not cut it off. */
export const bargeInVadOptions: VadOptions = {
  ...defaultVadOptions,
  startMarginDb: 24,
  minStartDbfs: -40,
  minSpeechMs: 300,
  warmupMs: 400,
};

/**
 * idle: no speech. pending: a candidate that is not confirmed yet. start: speech confirmed on
 * this frame. speech: inside an utterance. end: the utterance ended on this frame.
 */
export type VadDecision = "idle" | "pending" | "start" | "speech" | "end";

const FLOOR_RISE = 0.02;
const FLOOR_FALL = 0.2;
const WARMUP_RATE = 0.3;
const MIN_FLOOR_DBFS = -90;
const MAX_FLOOR_DBFS = -25;

/** Energy-based voice activity detector with an adaptive noise floor and hysteresis. */
export class EnergyVad {
  private floor: number;
  private phase: "idle" | "pending" | "speech" = "idle";
  private voicedMs = 0;
  private gapMs = 0;
  private utteranceMs = 0;
  private warmupLeftMs: number;

  constructor(private readonly options: VadOptions = defaultVadOptions) {
    this.floor = options.initialFloorDbfs;
    this.warmupLeftMs = options.warmupMs;
  }

  get noiseFloorDbfs(): number {
    return this.floor;
  }

  get startThresholdDbfs(): number {
    return Math.max(this.floor + this.options.startMarginDb, this.options.minStartDbfs);
  }

  get stopThresholdDbfs(): number {
    const { startMarginDb, stopMarginDb, minStartDbfs } = this.options;
    return Math.max(this.floor + stopMarginDb, minStartDbfs - (startMarginDb - stopMarginDb));
  }

  reset(): void {
    this.phase = "idle";
    this.voicedMs = 0;
    this.gapMs = 0;
    this.utteranceMs = 0;
  }

  push(levelDbfs: number): VadDecision {
    if (this.warmupLeftMs > 0) return this.warmUp(levelDbfs);
    switch (this.phase) {
      case "idle":
        return this.onIdle(levelDbfs);
      case "pending":
        return this.onPending(levelDbfs);
      case "speech":
        return this.onSpeech(levelDbfs);
    }
  }

  private warmUp(level: number): VadDecision {
    this.warmupLeftMs -= this.options.frameMs;
    this.floor = Math.max(MIN_FLOOR_DBFS, Math.min(MAX_FLOOR_DBFS, this.floor + (level - this.floor) * WARMUP_RATE));
    return "idle";
  }

  private onIdle(level: number): VadDecision {
    if (level < this.startThresholdDbfs) {
      this.adaptFloor(level);
      return "idle";
    }
    this.phase = "pending";
    this.voicedMs = this.options.frameMs;
    this.gapMs = 0;
    return this.confirmIfLongEnough();
  }

  private onPending(level: number): VadDecision {
    if (level >= this.stopThresholdDbfs) {
      this.voicedMs += this.options.frameMs;
      this.gapMs = 0;
      return this.confirmIfLongEnough();
    }
    this.gapMs += this.options.frameMs;
    if (this.gapMs >= this.options.candidateGapMs) {
      this.reset();
      this.adaptFloor(level);
      return "idle";
    }
    return "pending";
  }

  private onSpeech(level: number): VadDecision {
    this.utteranceMs += this.options.frameMs;
    this.gapMs = level >= this.stopThresholdDbfs ? 0 : this.gapMs + this.options.frameMs;
    if (this.gapMs >= this.options.endSilenceMs || this.utteranceMs >= this.options.maxUtteranceMs) {
      this.reset();
      return "end";
    }
    return "speech";
  }

  private confirmIfLongEnough(): VadDecision {
    if (this.voicedMs < this.options.minSpeechMs) return "pending";
    this.phase = "speech";
    this.utteranceMs = this.voicedMs;
    this.gapMs = 0;
    return "start";
  }

  private adaptFloor(level: number): void {
    const rate = level > this.floor ? FLOOR_RISE : FLOOR_FALL;
    this.floor = Math.max(MIN_FLOOR_DBFS, Math.min(MAX_FLOOR_DBFS, this.floor + (level - this.floor) * rate));
  }
}
