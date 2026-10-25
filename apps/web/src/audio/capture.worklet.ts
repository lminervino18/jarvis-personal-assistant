import { CAPTURE_FRAME_SAMPLES, Downsampler, Framer, floatToPcm16 } from "./pcm.js";

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class PcmCapture extends AudioWorkletProcessor {
  private readonly downsampler = new Downsampler(sampleRate);
  private readonly framer = new Framer(CAPTURE_FRAME_SAMPLES);

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const frames = this.framer.push(floatToPcm16(this.downsampler.process(channel)));
    for (const frame of frames) this.port.postMessage(frame.buffer, [frame.buffer]);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
