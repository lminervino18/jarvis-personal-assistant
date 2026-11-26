import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../tokens.js";
import type { TimelineScene, TimelineSceneContent } from "../timeline.js";
import type { Layout } from "./layout.js";
import { msToFrame, progressFrom } from "./motion.js";
import { Core } from "./Core.js";

interface Placement {
  x: number;
  y: number;
  size: number;
}

const VERTICAL: Record<TimelineSceneContent["type"], Placement> = {
  intro: { x: 0.5, y: 0.44, size: 0.86 },
  title: { x: 0.5, y: 0.5, size: 1 },
  media: { x: 0.86, y: 0.1, size: 0.36 },
  stat: { x: 0.5, y: 0.47, size: 1 },
  compare: { x: 0.84, y: 0.12, size: 0.46 },
  steps: { x: 0.84, y: 0.12, size: 0.46 },
  result: { x: 0.84, y: 0.12, size: 0.46 },
  question: { x: 0.84, y: 0.12, size: 0.46 },
  closing: { x: 0.5, y: 0.33, size: 0.78 },
};

const LANDSCAPE: Record<TimelineSceneContent["type"], Placement> = {
  intro: { x: 0.74, y: 0.5, size: 0.95 },
  title: { x: 0.72, y: 0.5, size: 1.05 },
  media: { x: 0.93, y: 0.14, size: 0.4 },
  stat: { x: 0.5, y: 0.5, size: 1.1 },
  compare: { x: 0.92, y: 0.16, size: 0.5 },
  steps: { x: 0.92, y: 0.16, size: 0.5 },
  result: { x: 0.92, y: 0.16, size: 0.5 },
  question: { x: 0.92, y: 0.16, size: 0.5 },
  closing: { x: 0.5, y: 0.36, size: 0.8 },
};

function placementOf(scene: TimelineScene | undefined, layout: Layout): Placement {
  const table = layout.vertical ? VERTICAL : LANDSCAPE;
  return table[scene?.content.type ?? "intro"];
}

/** How much the narration is speaking at `ms`, from 0 to 1: up while a word is said, fading right after it. */
export function speechLevel(scenes: TimelineScene[], ms: number): number {
  let level = 0;
  for (const scene of scenes) {
    if (ms < scene.startMs || ms > scene.startMs + scene.durationMs) continue;
    for (const word of scene.words) {
      const start = scene.startMs + word.startMs;
      const end = scene.startMs + word.endMs;
      if (ms >= start - 40 && ms <= end) level = Math.max(level, 0.75 + 0.25 * Math.sin(((ms - start) / 90) * Math.PI));
      else if (ms > end) level = Math.max(level, Math.exp(-(ms - end) / 220));
    }
  }
  return Math.min(1, level);
}

const Corner: React.FC<{ x: "left" | "right"; y: "top" | "bottom"; inset: number; size: number }> = ({ x, y, inset, size }) => (
  <div
    style={{
      position: "absolute",
      [x]: inset,
      [y]: inset,
      width: size,
      height: size,
      [`border${y === "top" ? "Top" : "Bottom"}`]: `3px solid ${hud.color.line}`,
      [`border${x === "left" ? "Left" : "Right"}`]: `3px solid ${hud.color.line}`,
    }}
  />
);

/**
 * The HUD behind every scene: deep navy with a faint grid, a slow scan line and screen corners,
 * and JARVIS's core gliding to a new spot when the scene changes, pulsing with the voice.
 */
export const Backdrop: React.FC<{ scenes: TimelineScene[]; layout: Layout }> = ({ scenes, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const index = Math.max(0, scenes.findLastIndex((scene) => msToFrame(scene.startMs, fps) <= frame));
  const current = scenes[index];
  const from = placementOf(scenes[index - 1] ?? current, layout);
  const to = placementOf(current, layout);
  const mix = index === 0 ? 1 : progressFrom(frame, msToFrame(current?.startMs ?? 0, fps), fps, 0.9);
  const base = layout.vertical ? layout.width : layout.height;
  const size = interpolate(mix, [0, 1], [from.size, to.size]) * base;
  const x = interpolate(mix, [0, 1], [from.x, to.x]) * layout.width;
  const y = interpolate(mix, [0, 1], [from.y, to.y]) * layout.height;
  const appear = progressFrom(frame, 0, fps, 1.2);
  const scan = ((frame / fps) % 6) / 6;
  const grid = Math.round(base / 18);
  return (
    <AbsoluteFill style={{ background: `radial-gradient(90% 60% at 50% 38%, ${hud.color.bgGlow}, ${hud.color.bg} 72%)`, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${hud.color.accentSoft} 1px, transparent 1px), linear-gradient(90deg, ${hud.color.accentSoft} 1px, transparent 1px)`,
          backgroundSize: `${grid}px ${grid}px`,
          opacity: 0.55,
          maskImage: "radial-gradient(75% 60% at 50% 45%, black, transparent)",
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, top: `${scan * 100}%`, height: 2, background: `linear-gradient(90deg, transparent, ${hud.color.glow}, transparent)`, opacity: 0.35 }} />
      <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: appear, scale: String(0.9 + 0.1 * appear) }}>
        <Core size={size} seconds={frame / fps} level={speechLevel(scenes, ms)} />
      </div>
      {(["top", "bottom"] as const).flatMap((vertical) =>
        (["left", "right"] as const).map((horizontal) => <Corner key={`${vertical}-${horizontal}`} x={horizontal} y={vertical} inset={Math.round(base * 0.03)} size={Math.round(base * 0.06)} />),
      )}
    </AbsoluteFill>
  );
};
