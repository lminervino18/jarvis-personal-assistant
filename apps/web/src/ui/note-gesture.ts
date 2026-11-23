export const LOCK_DISTANCE_PX = 70;
export const CANCEL_DISTANCE_PX = 110;

export type NoteGesture = "hold" | "lock" | "cancel";

interface Point {
  x: number;
  y: number;
}

/**
 * What a finger dragged from the microphone means, as in WhatsApp: far enough up locks the
 * recording so the owner can let go and keep talking, far enough left throws it away.
 */
export function noteGesture(start: Point, now: Point): NoteGesture {
  const up = start.y - now.y;
  const left = start.x - now.x;
  if (up >= LOCK_DISTANCE_PX && up >= left) return "lock";
  if (left >= CANCEL_DISTANCE_PX) return "cancel";
  return "hold";
}

/** How far the lock hint has travelled, from 0 at the press to 1 when the recording locks. */
export function lockProgress(start: Point, now: Point): number {
  return Math.min(1, Math.max(0, (start.y - now.y) / LOCK_DISTANCE_PX));
}
