import { levelFromDbfs, rmsDbfs } from "./pcm.js";
import type { SpeechDecision } from "./speech-vad.js";
import { EnergyVad, bargeInVadOptions, defaultVadOptions } from "./vad.js";

export interface VoiceLoopHandlers {
  /** Speech was confirmed. Returning false rejects it (e.g. the socket is down). */
  onStart(duringPlayback: boolean): boolean;
  onFrame(pcm: Int16Array): void;
  /** A short silence: the server may start transcribing in case the turn is ending. */
  onHint(): void;
  /** The owner went quiet inside the utterance; the server decides whether the turn ended. */
  onPause(): void;
  /** The owner kept talking after a pause. */
  onResume(): void;
  /** Speech that started over the assistant's reply went on long enough to be a real interruption. */
  onConfirmed(): void;
  onEnd(): void;
  onLevel(level: number): void;
  /** The listening window expired without speech. */
  onTimeout(): void;
}

/** Decides speech frame by frame; one detector serves one utterance at a time. */
export interface UtteranceDetector {
  push(frame: Int16Array): SpeechDecision;
  reset(): void;
  /** Voiced time inside the current utterance. */
  readonly voicedMs: number;
}

/** Builds the detector for normal listening, or the stricter one used while the assistant speaks. */
export type DetectorFactory = (playing: boolean) => UtteranceDetector;

export interface VoiceLoopOptions {
  prerollMs: number;
  frameMs: number;
  /** Voiced time that confirms speech heard over the reply as a real interruption. */
  confirmMs: number;
}

export const defaultVoiceLoopOptions: VoiceLoopOptions = {
  prerollMs: 300,
  frameMs: 20,
  confirmMs: 600,
};

/** Volume-based detection, used until Silero loads or where it cannot run. It ends turns by silence alone. */
export const energyDetectors: DetectorFactory = (playing) => {
  const vad = new EnergyVad(playing ? bargeInVadOptions : defaultVadOptions);
  let voicedMs = 0;
  return {
    push(frame) {
      const decision = vad.push(rmsDbfs(frame));
      if (decision === "start") voicedMs = defaultVadOptions.minSpeechMs;
      else if (decision === "speech") voicedMs += defaultVadOptions.frameMs;
      return decision;
    },
    reset() {
      vad.reset();
      voicedMs = 0;
    },
    get voicedMs() {
      return voicedMs;
    },
  };
};

/**
 * Turns a stream of 16 kHz microphone frames into utterances: pre-roll so the first syllable is
 * kept, pauses reported to the server instead of ending the turn, and speech over the reply treated
 * as a candidate until it lasts long enough to be a real interruption.
 */
export class VoiceLoop {
  private detector: UtteranceDetector;
  private detectorPlaying = false;
  private readonly preroll: Int16Array[] = [];
  private active = false;
  private playing = false;
  private overPlayback = false;
  private confirmed = false;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly handlers: VoiceLoopHandlers,
    private detectors: DetectorFactory = energyDetectors,
    private readonly options: VoiceLoopOptions = defaultVoiceLoopOptions,
  ) {
    this.detector = detectors(false);
  }

  get capturing(): boolean {
    return this.active;
  }

  /** Switches detection (e.g. to Silero once it loaded); takes effect at the next utterance. */
  useDetectors(detectors: DetectorFactory): void {
    this.detectors = detectors;
    if (!this.active) this.rebuildDetector();
  }

  /** Waits for speech; if none starts within `windowMs`, `onTimeout` fires. */
  startWindow(windowMs: number): void {
    this.clearWindow();
    if (this.active) return;
    this.windowTimer = setTimeout(() => {
      this.windowTimer = undefined;
      if (!this.active) this.handlers.onTimeout();
    }, windowMs);
  }

  clearWindow(): void {
    clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
  }

  /** While the assistant's speech plays, the stricter detector looks for interruptions. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  /** Drops the current utterance without reporting its end (cancelled, or ended by the server). */
  cancel(): void {
    this.active = false;
    this.detector.reset();
    this.preroll.length = 0;
  }

  dispose(): void {
    this.clearWindow();
    this.cancel();
  }

  push(frame: Int16Array): void {
    if (!this.active && this.playing !== this.detectorPlaying) this.rebuildDetector();
    this.handlers.onLevel(levelFromDbfs(rmsDbfs(frame)));
    const decision = this.detector.push(frame);
    if (!this.active) {
      this.remember(frame);
      if (decision === "start") this.begin();
      return;
    }
    this.handlers.onFrame(frame);
    if (decision === "hint") this.handlers.onHint();
    if (decision === "pause") this.handlers.onPause();
    if (decision === "resume") this.handlers.onResume();
    if (this.overPlayback && !this.confirmed && this.detector.voicedMs >= this.options.confirmMs) {
      this.confirmed = true;
      this.handlers.onConfirmed();
    }
    if (decision === "end") {
      this.active = false;
      this.handlers.onEnd();
    }
  }

  private begin(): void {
    this.clearWindow();
    const buffered = this.preroll.splice(0);
    this.overPlayback = this.detectorPlaying;
    if (!this.handlers.onStart(this.overPlayback)) {
      this.detector.reset();
      return;
    }
    this.active = true;
    this.confirmed = false;
    for (const frame of buffered) this.handlers.onFrame(frame);
  }

  private rebuildDetector(): void {
    this.detectorPlaying = this.playing;
    this.detector = this.detectors(this.playing);
    this.preroll.length = 0;
  }

  private remember(frame: Int16Array): void {
    this.preroll.push(frame);
    const maxFrames = Math.ceil(this.options.prerollMs / this.options.frameMs);
    if (this.preroll.length > maxFrames) this.preroll.shift();
  }
}
