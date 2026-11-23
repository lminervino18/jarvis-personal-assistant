import { Img, interpolate, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../../tokens.js";
import { msToFrame, rise } from "../motion.js";
import { GlassCard } from "../ui.js";
import { Stage, type SceneProps } from "./shared.js";

const FOCUS = { center: "50% 50%", top: "50% 20%", bottom: "50% 80%" } as const;

export const MediaScene: React.FC<SceneProps<"media">> = ({ scene, content, layout, assetBase }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const total = msToFrame(scene.durationMs, fps);
  const src = scene.media ? `${assetBase}/${scene.media.file}` : undefined;
  const style = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: FOCUS[content.focus],
    scale: String(interpolate(frame, [0, total], [1.04, 1.12])),
    translate: `0px ${interpolate(frame, [0, total], [12, -12])}px`,
  } as const;
  const hasText = Boolean(content.title || content.text);
  return (
    <Stage layout={layout} style={{ justifyContent: "flex-start" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 44, overflow: "hidden", background: pulso.color.uvMist, boxShadow: "0 60px 140px -60px rgba(58, 18, 214, 0.45)", ...rise(frame, 0, fps, 50) }}>
        {src && scene.media?.kind === "video" ? <OffthreadVideo src={src} muted style={style} /> : src ? <Img src={src} style={style} /> : null}
      </div>
      {hasText ? (
        <GlassCard style={{ marginTop: -150, marginInline: 28, gap: 16, padding: "40px 44px", ...rise(frame, 8, fps) }}>
          {content.title ? <h2 style={{ margin: 0, font: `700 58px/1.05 ${pulso.font.display}`, letterSpacing: "-0.02em", color: pulso.color.ink }}>{content.title}</h2> : null}
          {content.text ? <p style={{ margin: 0, font: `400 36px/1.4 ${pulso.font.text}`, color: pulso.color.muted }}>{content.text}</p> : null}
        </GlassCard>
      ) : null}
    </Stage>
  );
};
