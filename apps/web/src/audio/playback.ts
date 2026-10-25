import { pcm16BytesToFloat } from "./pcm.js";

export interface PlaybackBuffer {
  readonly duration: number;
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

export interface PlaybackSource {
  buffer: PlaybackBuffer | null;
  onended: ((event: Event) => void) | null;
  connect(destination: PlaybackDestination): void;
  disconnect(): void;
  start(when: number): void;
  stop(): void;
}

export type PlaybackDestination = object;

/** The part of AudioContext the player needs. */
export interface PlaybackContext {
  readonly currentTime: number;
  createBuffer(channels: number, length: number, sampleRate: number): PlaybackBuffer;
  createBufferSource(): PlaybackSource;
}

export interface PcmPlayerOptions {
  /** Delay added before the first chunk (and after an underrun) to absorb network jitter. */
  leadSeconds: number;
  /** Called with the context time at which a turn's first chunk will be heard. */
  onFirstAudio?(turnId: string, startsAt: number): void;
  /** Called when the turn's audio ended and every scheduled chunk finished playing. */
  onDrained?(turnId: string): void;
}

interface Playing {
  turnId: string;
  sampleRate: number;
  nextTime: number;
  carry: Uint8Array | null;
  ended: boolean;
  started: boolean;
}

/** Schedules PCM s16le chunks back to back on a Web Audio graph, one turn at a time. */
export class PcmPlayer {
  private current: Playing | null = null;
  private readonly sources = new Set<PlaybackSource>();

  constructor(
    private readonly context: PlaybackContext,
    private readonly destination: PlaybackDestination,
    private readonly options: PcmPlayerOptions,
  ) {}

  get turnId(): string | null {
    return this.current?.turnId ?? null;
  }

  get active(): boolean {
    return this.current !== null;
  }

  begin(turnId: string, sampleRate: number): void {
    if (this.current?.turnId === turnId) return;
    this.stop();
    this.current = { turnId, sampleRate, nextTime: 0, carry: null, ended: false, started: false };
  }

  enqueue(turnId: string, pcm: Uint8Array): void {
    const playing = this.current;
    if (!playing || playing.turnId !== turnId || playing.ended) return;
    const bytes = this.withCarry(playing, pcm);
    const samples = pcm16BytesToFloat(bytes);
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, playing.sampleRate);
    buffer.copyToChannel(samples, 0);
    const startAt = Math.max(playing.nextTime, this.context.currentTime + this.options.leadSeconds);
    this.schedule(buffer, startAt);
    playing.nextTime = startAt + buffer.duration;
    if (!playing.started) {
      playing.started = true;
      this.options.onFirstAudio?.(turnId, startAt);
    }
  }

  /** Marks the end of the turn's audio; the player drains what is already scheduled. */
  end(turnId: string): void {
    const playing = this.current;
    if (!playing || playing.turnId !== turnId) return;
    playing.ended = true;
    this.drainIfDone();
  }

  /** Silences everything immediately. */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.current = null;
  }

  private withCarry(playing: Playing, pcm: Uint8Array): Uint8Array {
    let bytes = pcm;
    if (playing.carry) {
      bytes = new Uint8Array(playing.carry.byteLength + pcm.byteLength);
      bytes.set(playing.carry, 0);
      bytes.set(pcm, playing.carry.byteLength);
      playing.carry = null;
    }
    if (bytes.byteLength % 2 === 1) {
      playing.carry = bytes.slice(bytes.byteLength - 1);
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    return bytes;
  }

  private schedule(buffer: PlaybackBuffer, startAt: number): void {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      this.drainIfDone();
    };
    this.sources.add(source);
    source.start(startAt);
  }

  private drainIfDone(): void {
    const playing = this.current;
    if (!playing?.ended || this.sources.size > 0) return;
    this.current = null;
    this.options.onDrained?.(playing.turnId);
  }
}
