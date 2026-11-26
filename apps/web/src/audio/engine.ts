import type { CaptureReport } from "@jarvis/contracts";
import { levelFromDbfs } from "./pcm.js";
import { PcmPlayer, type PcmPlayerOptions } from "./playback.js";
import captureWorkletUrl from "./capture.worklet.ts?worker&url";

export type MicFailure = "denied" | "unavailable";

const DUCKED_GAIN = 0.2;
const DUCK_TIME_CONSTANT = 0.03;

export class MicError extends Error {
  constructor(readonly reason: MicFailure) {
    super(reason);
  }
}

/** Everything the session needs from Web Audio, so tests and demo mode can replace it. */
export interface AudioEngine {
  readonly player: PcmPlayer;
  readonly running: boolean;
  /** Seconds on the audio clock, comparable with the times the player reports. */
  readonly currentTime: number;
  /** Must be called from a user gesture the first time. */
  resume(): Promise<void>;
  /** Level 0..1 of what is being played right now. */
  outputLevel(): number;
  startMicrophone(onFrame: (pcm: Int16Array) => void): Promise<void>;
  stopMicrophone(): void;
  onRunningChange(listener: () => void): void;
  /** What the browser applied to the last microphone it opened. */
  captureReport?(): CaptureReport | null;
  /** Lowers the reply while a possible interruption is checked, and restores it. */
  duck?(ducked: boolean): void;
  /** Plays a finished audio file (the welcome) through the same output, so the core moves with it; resolves when it ends. */
  playClip?(data: ArrayBuffer, onStart: () => void): Promise<void>;
  /** Whether a clip is playing now. */
  readonly clipPlaying?: boolean;
  stopClip?(): void;
}

interface Microphone {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
}

function describeCapture(stream: MediaStream, contextSampleRate: number): CaptureReport {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
  return {
    supported: { echoCancellation: supported.echoCancellation, noiseSuppression: supported.noiseSuppression, autoGainControl: supported.autoGainControl },
    applied: {
      echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : undefined,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
    },
    contextSampleRate,
  };
}

export class WebAudioEngine implements AudioEngine {
  readonly player: PcmPlayer;
  private readonly context = new AudioContext({ latencyHint: "interactive" });
  private readonly analyser = this.context.createAnalyser();
  private readonly output = this.context.createGain();
  private readonly samples: Float32Array<ArrayBuffer>;
  private workletLoaded: Promise<void> | null = null;
  private microphone: Microphone | null = null;
  private lastCapture: CaptureReport | null = null;
  private clip: AudioBufferSourceNode | null = null;

  constructor(playerOptions: PcmPlayerOptions) {
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.analyser.connect(this.context.destination);
    this.output.connect(this.analyser);
    this.player = new PcmPlayer(this.context, this.output, playerOptions);
  }

  get running(): boolean {
    return this.context.state === "running";
  }

  get currentTime(): number {
    return this.context.currentTime;
  }

  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  onRunningChange(listener: () => void): void {
    this.context.addEventListener("statechange", listener);
  }

  get clipPlaying(): boolean {
    return this.clip !== null;
  }

  async playClip(data: ArrayBuffer, onStart: () => void): Promise<void> {
    this.stopClip();
    const buffer = await this.context.decodeAudioData(data.slice(0));
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    this.clip = source;
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
      onStart();
    });
    if (this.clip === source) this.clip = null;
  }

  stopClip(): void {
    const clip = this.clip;
    this.clip = null;
    clip?.stop();
  }

  outputLevel(): number {
    if (!this.player.active && !this.clip) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.samples.length);
    return rms > 0 ? levelFromDbfs(20 * Math.log10(rms)) : 0;
  }

  async startMicrophone(onFrame: (pcm: Int16Array) => void): Promise<void> {
    if (this.microphone) return;
    const stream = await this.openStream();
    this.lastCapture = describeCapture(stream, this.context.sampleRate);
    try {
      this.workletLoaded ??= this.context.audioWorklet.addModule(captureWorkletUrl);
      await this.workletLoaded;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      this.workletLoaded = null;
      throw error;
    }
    const node = new AudioWorkletNode(this.context, "pcm-capture", { numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(new Int16Array(event.data));
    const sink = this.context.createGain();
    sink.gain.value = 0;
    const source = this.context.createMediaStreamSource(stream);
    source.connect(node);
    node.connect(sink);
    sink.connect(this.context.destination);
    this.microphone = { stream, source, node, sink };
  }

  captureReport(): CaptureReport | null {
    return this.lastCapture;
  }

  duck(ducked: boolean): void {
    this.output.gain.setTargetAtTime(ducked ? DUCKED_GAIN : 1, this.context.currentTime, DUCK_TIME_CONSTANT);
  }

  stopMicrophone(): void {
    const microphone = this.microphone;
    if (!microphone) return;
    this.microphone = null;
    microphone.node.port.onmessage = null;
    microphone.source.disconnect();
    microphone.node.disconnect();
    microphone.sink.disconnect();
    microphone.stream.getTracks().forEach((track) => track.stop());
  }

  private async openStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError("unavailable");
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      throw new MicError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
    }
  }
}
