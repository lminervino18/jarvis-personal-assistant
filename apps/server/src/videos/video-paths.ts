import { join } from "node:path";

/** Where a version keeps its narration and timeline: `<videosDir>/<id>/v<version>`. */
export function versionDir(videosDir: string, videoId: string, version: number): string {
  return join(videosDir, videoId, `v${version}`);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
