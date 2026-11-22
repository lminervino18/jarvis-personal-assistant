import { RING_COUNT, palette, type CoreAnimator, type CoreStyle, type Rgb } from "./core-style.js";

export type Quality = 0 | 1 | 2;

interface RingSpec {
  radius: number;
  width: number;
  segments: number;
  fill: number;
}

const RINGS: readonly RingSpec[] = [
  { radius: 0.4, width: 0.02, segments: 3, fill: 0.62 },
  { radius: 0.55, width: 0.012, segments: 8, fill: 0.55 },
  { radius: 0.7, width: 0.024, segments: 5, fill: 0.7 },
  { radius: 0.86, width: 0.011, segments: 24, fill: 0.5 },
];

const TAU = Math.PI * 2;

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(3)})`;
}

function drawHalo(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  const reach = radius * (0.78 + animator.level * 0.2);
  const gradient = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, reach);
  gradient.addColorStop(0, rgba(animator.color, 0.1 + animator.glow * 0.3 + animator.level * 0.35));
  gradient.addColorStop(0.55, rgba(animator.color, 0.03 + animator.glow * 0.08));
  gradient.addColorStop(1, rgba(animator.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, reach, 0, TAU);
  ctx.fill();
}

function drawRing(ctx: CanvasRenderingContext2D, radius: number, index: number, animator: CoreAnimator, style: CoreStyle, quality: Quality): void {
  const spec = RINGS[index] as RingSpec;
  const segments = quality === 0 || (quality === 1 && index === 3) ? Math.ceil(spec.segments / 2) : spec.segments;
  const step = TAU / segments;
  const accent = index === style.accentRing;
  const color = accent ? palette.amber : index % 2 === 1 ? mixToward(animator.color, palette.blue, 0.55) : animator.color;
  const outer = index === RING_COUNT - 1;
  ctx.lineCap = "round";
  ctx.lineWidth = spec.width * radius * 2 * (1 + (outer ? animator.level * 1.2 : 0));
  for (let k = 0; k < segments; k++) {
    const bump = outer ? animator.level * 0.05 * (0.5 + 0.5 * Math.sin(k * 1.7 + animator.clock * 6)) : 0;
    const ringRadius = radius * (spec.radius + bump);
    const start = (animator.angles[index] as number) + k * step;
    ctx.strokeStyle = rgba(color, (accent ? 0.9 : 0.34 + index * 0.08) + animator.level * 0.35);
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, start, start + step * spec.fill);
    ctx.stroke();
  }
}

function mixToward(from: Rgb, to: Rgb, amount: number): Rgb {
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount, from[2] + (to[2] - from[2]) * amount];
}

function drawSweep(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  const pieces = 14;
  ctx.lineCap = "round";
  ctx.lineWidth = radius * 0.03;
  for (let i = 0; i < pieces; i++) {
    const fade = 1 - i / pieces;
    const end = animator.sweepAngle - i * 0.07;
    ctx.strokeStyle = rgba(palette.lightCyan, 0.85 * fade * fade);
    ctx.beginPath();
    ctx.arc(0, 0, radius * RINGS[1]!.radius, end - 0.07, end);
    ctx.stroke();
  }
}

const TICKS = 72;
const LIT_TICKS = 9;

function drawTicks(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  const offset = -(animator.angles[3] as number) * 0.4;
  const lit = Math.floor(animator.orbit * 6) % TICKS;
  ctx.lineWidth = Math.max(1, radius * 0.006);
  for (let i = 0; i < TICKS; i++) {
    const angle = offset + (i / TICKS) * TAU;
    const distance = (i - lit + TICKS) % TICKS;
    const glow = distance < LIT_TICKS ? 1 - distance / LIT_TICKS : 0;
    const inner = radius * (i % 6 === 0 ? 0.935 : 0.955);
    ctx.strokeStyle = rgba(glow > 0 ? palette.lightCyan : animator.color, 0.2 + glow * 0.7);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * radius * 0.975, Math.sin(angle) * radius * 0.975);
    ctx.stroke();
  }
}

function drawReticle(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  ctx.lineWidth = Math.max(1, radius * 0.004);
  ctx.strokeStyle = rgba(animator.color, 0.14 + animator.glow * 0.1);
  for (const ring of [0.31, 0.63, 0.995]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * ring, 0, TAU);
    ctx.stroke();
  }
  const spin = animator.orbit * 0.12;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const angle = spin + (i * TAU) / 4;
    ctx.moveTo(Math.cos(angle) * radius * 0.64, Math.sin(angle) * radius * 0.64);
    ctx.lineTo(Math.cos(angle) * radius * 0.69, Math.sin(angle) * radius * 0.69);
  }
  ctx.stroke();
}

function drawReadouts(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  ctx.lineCap = "butt";
  ctx.lineWidth = radius * 0.016;
  for (let i = 0; i < 3; i++) {
    const start = -animator.orbit * 0.35 + (i * TAU) / 3;
    const length = 0.18 + 0.12 * Math.sin(animator.clock * 0.9 + i * 2);
    ctx.strokeStyle = rgba(i === 0 ? palette.lightCyan : animator.color, 0.42 + animator.level * 0.3);
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.915, start, start + length);
    ctx.stroke();
  }
}

const ORBITERS = [
  { ring: 1, speed: 1, phase: 0 },
  { ring: 2, speed: -0.72, phase: 2.1 },
  { ring: 3, speed: 0.46, phase: 4 },
  { ring: 2, speed: -0.72, phase: 5.2 },
  { ring: 3, speed: 0.46, phase: 1.3 },
] as const;

function drawOrbiters(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  const size = radius * (0.013 + animator.level * 0.012);
  ctx.lineCap = "round";
  for (const orbiter of ORBITERS) {
    const angle = animator.orbit * orbiter.speed + orbiter.phase;
    const distance = radius * (RINGS[orbiter.ring] as RingSpec).radius;
    const trail = 0.4 + animator.level * 0.3;
    ctx.strokeStyle = rgba(palette.lightCyan, 0.28);
    ctx.lineWidth = size;
    ctx.beginPath();
    if (orbiter.speed > 0) ctx.arc(0, 0, distance, angle - trail, angle);
    else ctx.arc(0, 0, distance, angle, angle + trail);
    ctx.stroke();
    ctx.fillStyle = rgba(palette.lightCyan, 0.95);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, size, 0, TAU);
    ctx.fill();
  }
}

const BARS = 56;

function drawEqualizer(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator): void {
  const energy = Math.max(animator.level, animator.glow * 0.12);
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, radius * 0.011);
  const inner = radius * 0.27;
  for (let i = 0; i < BARS; i++) {
    const angle = (i / BARS) * TAU + animator.orbit * 0.25;
    const wave = 0.5 + 0.5 * Math.sin(i * 2.3 + animator.clock * 9) * Math.sin(i * 0.7 - animator.clock * 5);
    const length = radius * (0.015 + energy * 0.19 * wave);
    ctx.strokeStyle = rgba(palette.lightCyan, 0.25 + energy * 0.7);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * (inner + length), Math.sin(angle) * (inner + length));
    ctx.stroke();
  }
}

function drawDisc(ctx: CanvasRenderingContext2D, radius: number, animator: CoreAnimator, style: CoreStyle): void {
  const breathing = style.breathe * Math.sin(animator.clock * 1.6);
  const size = radius * (0.2 + animator.level * 0.05 + breathing * 0.2);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, size);
  gradient.addColorStop(0, rgba(palette.lightCyan, 0.95));
  gradient.addColorStop(0.45, rgba(animator.color, 0.75));
  gradient.addColorStop(1, rgba(animator.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, TAU);
  ctx.fill();
}

/** Draws one frame centered in a square canvas of `size` CSS pixels. */
const COMPACT_MAX_PX = 120;

export function drawCore(ctx: CanvasRenderingContext2D, size: number, animator: CoreAnimator, style: CoreStyle, quality: Quality): void {
  const radius = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(radius, radius);
  drawHalo(ctx, radius, animator);
  if (size <= COMPACT_MAX_PX) {
    for (const index of [0, 2]) drawRing(ctx, radius, index, animator, style, 0);
    if (style.sweep) drawSweep(ctx, radius, animator);
    drawDisc(ctx, radius, animator, style);
    ctx.restore();
    return;
  }
  if (quality > 0) drawReticle(ctx, radius, animator);
  const rings = quality === 0 ? [0, 2, 3] : [0, 1, 2, 3];
  for (const index of rings) drawRing(ctx, radius, index, animator, style, quality);
  if (style.sweep) drawSweep(ctx, radius, animator);
  if (quality === 2) drawTicks(ctx, radius, animator);
  if (quality > 0) drawReadouts(ctx, radius, animator);
  if (quality > 0) drawOrbiters(ctx, radius, animator);
  drawEqualizer(ctx, radius, animator);
  drawDisc(ctx, radius, animator, style);
  ctx.restore();
}
