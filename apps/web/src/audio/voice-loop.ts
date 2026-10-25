import { levelFromDbfs, rmsDbfs } from "./pcm.js";
import { EnergyVad, bargeInVadOptions, defaultVadOptions, type VadOptions } from "./vad.js";

export interface VoiceLoopHandlers {
  /** Speech was confirmed. Returning false rejects it (e.g. the socket is down). */
  onStart(): boolean;
  onFrame(pcm: Int16Array): void;
  onEnd(): void;
  onLevel(level: number): void;
  /** The listening window expired without speech. */
  onTimeout(): void;
}

export interface VoiceLoopOptions {
  prerollMs: number;
  frameMs: number;
  vad: VadOptions;
  bargeInVad: VadOptions;
}

export const defaultVoiceLoopOptions: VoiceLoopOptions = {
  prerollMs: 300,
  frameMs: 20,
  vad: defaultVadOptions,
  bargeInVad: bargeInVadOptions,
};

/**
 * Turns a stream of 16 kHz microphone frames into utterances: pre-roll so the first syllable
 * is kept, a stricter detector while the assistant speaks (echo), and a listening window.
 */
export class VoiceLoop {
  private vad: EnergyVad;
  private readonly normalVad: EnergyVad;
  private readonly preroll: Int16Array[] = [];
  private active = false;
  private playing = false;
  private vadPlaying = false;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly handlers: VoiceLoopHandlers,
    private readonly options: VoiceLoopOptions = defaultVoiceLoopOptions,
  ) {
    this.normalVad = new EnergyVad(options.vad);
    this.vad = this.normalVad;
  }

  get capturing(): boolean {
    return this.active;
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

  /** While the assistant's speech plays, the echo-tolerant detector decides about barge-in. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  /** Drops the current utterance without reporting its end. */
  cancel(): void {
    this.active = false;
    this.vad.reset();
    this.preroll.length = 0;
  }

  dispose(): void {
    this.clearWindow();
    this.cancel();
  }

  push(frame: Int16Array): void {
    if (!this.active) this.selectVad();
    this.handlers.onLevel(levelFromDbfs(rmsDbfs(frame)));
    const decision = this.vad.push(rmsDbfs(frame));
    if (this.active) {
      this.handlers.onFrame(frame);
      if (decision === "end") {
        this.active = false;
        this.handlers.onEnd();
      }
      return;
    }
    this.remember(frame);
    if (decision === "start") this.begin();
  }

  private begin(): void {
    this.clearWindow();
    const buffered = this.preroll.splice(0);
    if (!this.handlers.onStart()) {
      this.vad.reset();
      return;
    }
    this.active = true;
    for (const frame of buffered) this.handlers.onFrame(frame);
  }

  private selectVad(): void {
    if (this.playing === this.vadPlaying) return;
    this.vadPlaying = this.playing;
    this.vad = this.playing ? new EnergyVad(this.options.bargeInVad) : this.normalVad;
    this.vad.reset();
    this.preroll.length = 0;
  }

  private remember(frame: Int16Array): void {
    this.preroll.push(frame);
    const maxFrames = Math.ceil(this.options.prerollMs / this.options.frameMs);
    if (this.preroll.length > maxFrames) this.preroll.shift();
  }
}
