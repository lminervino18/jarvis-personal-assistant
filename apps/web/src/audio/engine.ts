import { levelFromDbfs } from "./pcm.js";
import { PcmPlayer, type PcmPlayerOptions } from "./playback.js";
import captureWorkletUrl from "./capture.worklet.ts?worker&url";

export type MicFailure = "denied" | "unavailable";

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
}

interface Microphone {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
}

export class WebAudioEngine implements AudioEngine {
  readonly player: PcmPlayer;
  private readonly context = new AudioContext({ latencyHint: "interactive" });
  private readonly analyser = this.context.createAnalyser();
  private readonly samples: Float32Array<ArrayBuffer>;
  private workletLoaded: Promise<void> | null = null;
  private microphone: Microphone | null = null;

  constructor(playerOptions: PcmPlayerOptions) {
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.analyser.connect(this.context.destination);
    this.player = new PcmPlayer(this.context, this.analyser, playerOptions);
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

  outputLevel(): number {
    if (!this.player.active) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.samples.length);
    return rms > 0 ? levelFromDbfs(20 * Math.log10(rms)) : 0;
  }

  async startMicrophone(onFrame: (pcm: Int16Array) => void): Promise<void> {
    if (this.microphone) return;
    const stream = await this.openStream();
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
