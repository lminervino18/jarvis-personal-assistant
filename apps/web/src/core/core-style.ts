import type { AssistantState } from "@jarvis/contracts";

export type Rgb = readonly [number, number, number];

export const palette = {
  cyan: [70, 227, 255],
  lightCyan: [143, 239, 255],
  blue: [43, 92, 255],
  amber: [245, 184, 65],
  dim: [96, 128, 170],
} as const satisfies Record<string, Rgb>;

export type LevelSource = "input" | "output" | "none";

export interface CoreStyle {
  /** Rotation speed multiplier. */
  speed: number;
  color: Rgb;
  /** Ring that carries the amber accent, or -1. */
  accentRing: number;
  /** Baseline brightness of the halo, 0..1. */
  glow: number;
  /** Amplitude of the idle breathing, as a fraction of the disc radius. */
  breathe: number;
  sweep: boolean;
  source: LevelSource;
}

export const coreStyles: Record<AssistantState, CoreStyle> = {
  offline: { speed: 0.04, color: palette.dim, accentRing: -1, glow: 0.08, breathe: 0, sweep: false, source: "none" },
  connecting: { speed: 0.5, color: palette.dim, accentRing: -1, glow: 0.2, breathe: 0.02, sweep: true, source: "none" },
  idle: { speed: 0.14, color: palette.cyan, accentRing: -1, glow: 0.3, breathe: 0.05, sweep: false, source: "none" },
  listening: { speed: 0.26, color: palette.lightCyan, accentRing: -1, glow: 0.4, breathe: 0.02, sweep: false, source: "input" },
  transcribing: { speed: 0.7, color: palette.cyan, accentRing: -1, glow: 0.4, breathe: 0.02, sweep: true, source: "none" },
  thinking: { speed: 1.1, color: palette.blue, accentRing: -1, glow: 0.45, breathe: 0.03, sweep: true, source: "none" },
  using_tool: { speed: 0.9, color: palette.cyan, accentRing: 2, glow: 0.45, breathe: 0.03, sweep: true, source: "none" },
  speaking: { speed: 0.34, color: palette.cyan, accentRing: -1, glow: 0.5, breathe: 0.02, sweep: false, source: "output" },
  interrupted: { speed: 0.08, color: palette.amber, accentRing: 0, glow: 0.3, breathe: 0, sweep: false, source: "none" },
  error: { speed: 0.02, color: palette.amber, accentRing: 0, glow: 0.22, breathe: 0, sweep: false, source: "none" },
};

export interface LevelReading {
  input: number;
  output: number;
}

export function targetLevel(style: CoreStyle, levels: LevelReading): number {
  if (style.source === "input") return levels.input;
  if (style.source === "output") return levels.output;
  return 0;
}

const ATTACK_MS = 60;
const RELEASE_MS = 220;

/** Fast rise, slower fall, independent of the frame rate. */
export function smoothLevel(current: number, target: number, dtMs: number): number {
  const constant = target > current ? ATTACK_MS : RELEASE_MS;
  return current + (target - current) * (1 - Math.exp(-dtMs / constant));
}

export function mixColor(from: Rgb, to: Rgb, amount: number): Rgb {
  return [0, 1, 2].map((i) => (from[i] as number) + ((to[i] as number) - (from[i] as number)) * amount) as unknown as Rgb;
}

export const RING_COUNT = 4;
const COLOR_MS = 350;

/** Holds the continuous values that move toward the current style, one step per frame. */
export class CoreAnimator {
  readonly angles: number[] = [0.4, 1.9, 3.1, 5.2];
  level = 0;
  glow = 0.3;
  color: Rgb = palette.dim;
  sweepAngle = 0;
  clock = 0;

  step(dtMs: number, style: CoreStyle, levels: LevelReading, reducedMotion: boolean): void {
    this.clock += dtMs / 1000;
    this.level = smoothLevel(this.level, targetLevel(style, levels), dtMs);
    const follow = 1 - Math.exp(-dtMs / COLOR_MS);
    this.color = mixColor(this.color, style.color, follow);
    this.glow += (style.glow - this.glow) * follow;
    if (reducedMotion) return;
    const advance = (dtMs / 1000) * style.speed;
    this.angles.forEach((angle, i) => {
      const direction = i % 2 === 0 ? 1 : -1;
      this.angles[i] = (angle + direction * advance * (0.9 - i * 0.18)) % (Math.PI * 2);
    });
    this.sweepAngle = (this.sweepAngle + advance * 3.2) % (Math.PI * 2);
  }
}
