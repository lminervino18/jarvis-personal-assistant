import type { CSSProperties, ReactNode } from "react";
import type { TimelineScene, TimelineSceneContent } from "../../timeline.js";
import type { Layout } from "../layout.js";
import { msToFrame } from "../motion.js";

export interface SceneProps<T extends TimelineSceneContent["type"]> {
  scene: TimelineScene;
  content: Extract<TimelineSceneContent, { type: T }>;
  layout: Layout;
  assetBase: string;
}

/** The frame (scene-relative) at which item `index` appears; the first item defaults to the start of speech. */
export function cueFrame(scene: TimelineScene, index: number, fps: number): number {
  return msToFrame(scene.cues[index] ?? scene.audio.startMs, fps);
}

export const Stage: React.FC<{ layout: Layout; children: ReactNode; style?: CSSProperties }> = ({ layout, children, style }) => (
  <div
    style={{
      position: "absolute",
      top: layout.top,
      bottom: layout.bottom,
      left: layout.side,
      right: layout.side,
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      gap: 40,
      ...style,
    }}
  >
    {children}
  </div>
);
