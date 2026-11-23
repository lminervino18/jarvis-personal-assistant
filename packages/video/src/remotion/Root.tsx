import { Composition } from "remotion";
import { JarvisVideo } from "../composition/JarvisVideo.js";
import { sampleTimeline } from "../sample.js";
import type { VideoTimeline } from "../timeline.js";

export const COMPOSITION_ID = "jarvis-video";

export const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={JarvisVideo}
    defaultProps={sampleTimeline()}
    fps={30}
    width={1080}
    height={1920}
    durationInFrames={30}
    calculateMetadata={({ props }: { props: VideoTimeline }) => ({
      durationInFrames: Math.max(1, Math.round((props.durationMs / 1000) * props.fps)),
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
