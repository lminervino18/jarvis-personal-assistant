import { AbsoluteFill, Html5Audio, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { ReactNode } from "react";
import { hud } from "../tokens.js";
import type { TimelineScene, VideoTimeline } from "../timeline.js";
import { Backdrop } from "./Backdrop.js";
import { Captions } from "./Captions.js";
import { loadFonts } from "./fonts.js";
import { layoutOf, type Layout } from "./layout.js";
import { msToFrame } from "./motion.js";
import { ClosingScene } from "./scenes/Closing.js";
import { CompareScene } from "./scenes/Compare.js";
import { IntroScene } from "./scenes/Intro.js";
import { MediaScene } from "./scenes/Media.js";
import { QuestionScene } from "./scenes/Question.js";
import { ResultScene } from "./scenes/Result.js";
import { StatScene } from "./scenes/Stat.js";
import { StepsScene } from "./scenes/Steps.js";
import { TitleScene } from "./scenes/Title.js";

void loadFonts();

const EXIT_FRAMES = 9;

const SceneShell: React.FC<{ frames: number; children: ReactNode }> = ({ frames, children }) => {
  const frame = useCurrentFrame();
  const leaving = interpolate(frame, [frames - EXIT_FRAMES, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: 1 - leaving, translate: `0px ${-24 * leaving}px` }}>{children}</AbsoluteFill>;
};

function SceneView({ scene, layout, assetBase }: { scene: TimelineScene; layout: Layout; assetBase: string }) {
  const content = scene.content;
  switch (content.type) {
    case "intro":
      return <IntroScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "title":
      return <TitleScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "media":
      return <MediaScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "compare":
      return <CompareScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "stat":
      return <StatScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "steps":
      return <StepsScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "result":
      return <ResultScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "question":
      return <QuestionScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
    case "closing":
      return <ClosingScene scene={scene} content={content} layout={layout} assetBase={assetBase} />;
  }
}

const TopBar: React.FC<{ layout: Layout; totalFrames: number }> = ({ layout, totalFrames }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", top: layout.vertical ? 84 : 48, left: layout.side, right: layout.side, display: "flex", alignItems: "center", gap: 26 }}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", background: hud.color.accent, boxShadow: `0 0 18px ${hud.color.glow}`, opacity: 0.6 + 0.4 * Math.abs(Math.sin(frame / 12)) }} />
      <span style={{ font: `700 28px/1 ${hud.font.display}`, letterSpacing: "0.3em", color: hud.color.text }}>J.A.R.V.I.S</span>
      <div style={{ flex: 1, height: 3, background: "rgba(63, 224, 255, 0.14)" }}>
        <div style={{ width: `${(frame / Math.max(totalFrames - 1, 1)) * 100}%`, height: 3, background: hud.color.accent, boxShadow: `0 0 14px ${hud.color.glow}` }} />
      </div>
    </div>
  );
};

/** A JARVIS video: the HUD backdrop with its core, one sequence per narrated scene with its audio, and burned-in captions. */
export const JarvisVideo: React.FC<VideoTimeline> = (timeline) => {
  const { fps } = useVideoConfig();
  const layout = layoutOf(timeline);
  const totalFrames = msToFrame(timeline.durationMs, fps);
  return (
    <AbsoluteFill style={{ background: hud.color.bg, fontFamily: hud.font.text, color: hud.color.text }}>
      <Backdrop scenes={timeline.scenes} layout={layout} />
      <TopBar layout={layout} totalFrames={totalFrames} />
      {timeline.scenes.map((scene, index) => {
        const from = msToFrame(scene.startMs, fps);
        const frames = msToFrame(scene.startMs + scene.durationMs, fps) - from;
        return (
          <Sequence key={index} from={from} durationInFrames={frames} name={`${index + 1}. ${scene.content.type}`}>
            <SceneShell frames={frames}>
              <SceneView scene={scene} layout={layout} assetBase={timeline.assetBase} />
            </SceneShell>
            {scene.audio.file ? (
              <Sequence from={msToFrame(scene.audio.startMs, fps)} layout="none">
                <Html5Audio src={`${timeline.assetBase}/${scene.audio.file}`} />
              </Sequence>
            ) : null}
          </Sequence>
        );
      })}
      <Captions pages={timeline.captions} layout={layout} />
    </AbsoluteFill>
  );
};
