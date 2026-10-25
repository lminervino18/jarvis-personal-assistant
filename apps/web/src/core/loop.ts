import type { AssistantState } from "@jarvis/contracts";
import { CoreAnimator, coreStyles, type LevelReading } from "./core-style.js";
import { drawCore, type Quality } from "./draw.js";

const SLOW_FRAME_MS = 24;
const FAST_FRAME_MS = 13;
const WINDOW_FRAMES = 90;
const REDUCED_MOTION_FRAME_MS = 250;
const MAX_DPR = 2;

export interface CoreLoopOptions {
  canvas: HTMLCanvasElement;
  readState(): AssistantState;
  readLevels(): LevelReading;
}

/** Tracks frame cost and lowers the drawing quality when frames take too long. */
export class QualityGovernor {
  private total = 0;
  private frames = 0;

  constructor(public quality: Quality) {}

  record(frameMs: number): void {
    this.total += frameMs;
    if (++this.frames < WINDOW_FRAMES) return;
    const average = this.total / this.frames;
    this.total = 0;
    this.frames = 0;
    if (average > SLOW_FRAME_MS && this.quality > 0) this.quality = (this.quality - 1) as Quality;
    else if (average < FAST_FRAME_MS && this.quality < this.ceiling) this.quality = (this.quality + 1) as Quality;
  }

  private ceiling: Quality = 2;

  capAt(ceiling: Quality): void {
    this.ceiling = ceiling;
    if (this.quality > ceiling) this.quality = ceiling;
  }
}

/** Starts the animation loop and returns a function that stops it. */
export function startCoreLoop({ canvas, readState, readLevels }: CoreLoopOptions): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;
  const ctx: CanvasRenderingContext2D = context;
  const animator = new CoreAnimator();
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const governor = new QualityGovernor(coarse ? 1 : 2);
  governor.capAt(coarse ? 1 : 2);
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let size = 0;
  let visible = true;
  let frame = 0;
  let last = 0;

  const resize = (width: number) => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    size = Math.max(1, Math.round(width));
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const tick = (now: number) => {
    frame = 0;
    if (!visible || document.hidden) return;
    frame = requestAnimationFrame(tick);
    const elapsed = last === 0 ? 16 : now - last;
    if (motion.matches && elapsed < REDUCED_MOTION_FRAME_MS && last !== 0) return;
    last = now;
    const dt = Math.min(elapsed, 100);
    const style = coreStyles[readState()];
    animator.step(dt, style, readLevels(), motion.matches);
    const started = performance.now();
    drawCore(ctx, size, animator, style, governor.quality);
    if (!motion.matches) governor.record(Math.max(dt, performance.now() - started));
  };

  const wake = () => {
    if (frame === 0 && visible && !document.hidden) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  };

  const resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    resize(entry.contentRect.width);
    wake();
  });
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    wake();
  });
  resizeObserver.observe(canvas);
  intersection.observe(canvas);
  document.addEventListener("visibilitychange", wake);
  wake();

  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersection.disconnect();
    document.removeEventListener("visibilitychange", wake);
  };
}
