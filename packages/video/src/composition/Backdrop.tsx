import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../tokens.js";
import type { TimelineScene, TimelineSceneContent } from "../timeline.js";
import type { Layout } from "./layout.js";
import { msToFrame, progressFrom } from "./motion.js";
import { Orb } from "./Orb.js";

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

/** White page with the orb behind the content; the orb glides to a new spot when the scene changes. */
export const Backdrop: React.FC<{ scenes: TimelineScene[]; layout: Layout }> = ({ scenes, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
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
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 10% 0%, ${pulso.color.uvMist}, ${pulso.color.white} 60%)` }}>
      <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: appear, scale: String(0.9 + 0.1 * appear) }}>
        <Orb size={size} seconds={frame / fps} />
      </div>
    </AbsoluteFill>
  );
};
