import type { PlaybackBuffer, PlaybackContext, PlaybackSource } from "./playback.js";

export class FakeSource implements PlaybackSource {
  buffer: PlaybackBuffer | null = null;
  onended: ((event: Event) => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  disconnected = false;
  connect(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  start(when: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
  finish(): void {
    this.onended?.(new Event("ended"));
  }
}

export class FakePlaybackContext implements PlaybackContext {
  currentTime = 10;
  sources: FakeSource[] = [];
  buffers: { length: number; sampleRate: number }[] = [];

  createBuffer(_channels: number, length: number, sampleRate: number): PlaybackBuffer {
    this.buffers.push({ length, sampleRate });
    return { duration: length / sampleRate, copyToChannel: () => {} };
  }

  createBufferSource(): PlaybackSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}
