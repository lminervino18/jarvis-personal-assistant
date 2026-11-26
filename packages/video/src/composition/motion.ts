import { Easing, interpolate } from "remotion";
import { hud } from "../tokens.js";

const RISE_EASING = Easing.bezier(...hud.rise.bezier);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** The docs' entrance: content rises a little and fades in, starting at `atFrame`. */
export function rise(frame: number, atFrame: number, fps: number, distance = 36): { opacity: number; translate: string } {
  const progress = interpolate(frame, [atFrame, atFrame + hud.rise.seconds * fps], [0, 1], { ...clamp, easing: RISE_EASING });
  return { opacity: progress, translate: `0px ${(1 - progress) * distance}px` };
}

/** 0 → 1 over `seconds` from `atFrame`, with the docs' easing. */
export function progressFrom(frame: number, atFrame: number, fps: number, seconds: number): number {
  return interpolate(frame, [atFrame, atFrame + seconds * fps], [0, 1], { ...clamp, easing: RISE_EASING });
}

export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}
