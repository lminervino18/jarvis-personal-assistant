const COMB_DELAY_SECONDS = 0.0022;
const CARRIER_HZ = 80;
const COMB_GAIN = 0.55;
const RING_MIX = 0.35;

/**
 * Subtle metallic coloration: a short feed-forward comb plus a faint low-frequency ring
 * modulation. Intensity runs from 0 (bypass) to 1; the default for natural voices is low.
 */
export class RoboticEffect {
  readonly intensity: number;
  private readonly delay: number;
  private readonly history: Float32Array;
  private writeIndex = 0;
  private tick = 0;

  constructor(
    private readonly sampleRate: number,
    intensity: number,
  ) {
    this.intensity = Math.min(1, Math.max(0, intensity));
    this.delay = Math.max(1, Math.round(sampleRate * COMB_DELAY_SECONDS));
    this.history = new Float32Array(this.delay);
  }

  get active(): boolean {
    return this.intensity > 0;
  }

  process(input: Int16Array): Int16Array {
    if (!this.active) return input;
    const comb = COMB_GAIN * this.intensity;
    const ring = RING_MIX * this.intensity;
    const gain = 1 / Math.hypot(1, comb);
    const level = Math.hypot(1 - ring, ring * Math.SQRT1_2);
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = input[i] as number;
      const delayed = this.history[this.writeIndex] as number;
      this.history[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.delay;
      const carrier = Math.sin((2 * Math.PI * CARRIER_HZ * this.tick) / this.sampleRate);
      this.tick = (this.tick + 1) % this.sampleRate;
      const colored = (sample + comb * delayed) * gain;
      const mixed = (colored * (1 - ring) + sample * carrier * ring) / level;
      output[i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
    }
    return output;
  }
}
