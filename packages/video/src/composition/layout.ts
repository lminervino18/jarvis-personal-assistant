import type { VideoTimeline } from "../timeline.js";

export interface Layout {
  vertical: boolean;
  width: number;
  height: number;
  side: number;
  top: number;
  bottom: number;
  owner: string;
}

export function layoutOf(timeline: VideoTimeline): Layout {
  const vertical = timeline.format === "vertical";
  const intro = timeline.scenes[0]?.content;
  const owner = intro?.type === "intro" ? intro.owner : "";
  return vertical
    ? { vertical, width: timeline.width, height: timeline.height, side: 76, top: 190, bottom: 400, owner }
    : { vertical, width: timeline.width, height: timeline.height, side: 150, top: 110, bottom: 230, owner };
}

/** A title size that fits `lines` lines of the given width, between `min` and `max` pixels. */
export function fitSize(text: string, width: number, lines: number, min: number, max: number): number {
  const fit = Math.floor((lines * width) / (0.6 * Math.max(text.length, 1)));
  return Math.max(min, Math.min(max, fit));
}
