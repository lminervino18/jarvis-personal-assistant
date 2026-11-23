import { JarvisVideo, type VideoTimeline } from "@jarvis/video";
import { Player } from "@remotion/player";

/** The animated preview, drawn live from the same composition the server renders. Loaded only on demand. */
export default function VideoPreview({ timeline }: { timeline: VideoTimeline }) {
  return (
    <Player
      component={JarvisVideo}
      inputProps={timeline}
      durationInFrames={Math.max(1, Math.round((timeline.durationMs / 1000) * timeline.fps))}
      compositionWidth={timeline.width}
      compositionHeight={timeline.height}
      fps={timeline.fps}
      controls
      acknowledgeRemotionLicense
      style={{ width: "100%", aspectRatio: `${timeline.width} / ${timeline.height}`, borderRadius: 14, overflow: "hidden" }}
    />
  );
}
