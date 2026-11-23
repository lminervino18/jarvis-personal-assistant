import { useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../../tokens.js";
import { fitSize } from "../layout.js";
import { msToFrame, progressFrom, rise } from "../motion.js";
import { EmojiBadge, GlassCard, Kicker } from "../ui.js";
import { Stage, type SceneProps } from "./shared.js";

export const TitleScene: React.FC<SceneProps<"title">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = Math.max(0, msToFrame(scene.audio.startMs, fps) - 8);
  const words = content.title.split(/\s+/);
  const size = fitSize(content.title, layout.width - layout.side * 2 - 104, 3, 60, 112);
  const pop = progressFrom(frame, start, fps, 0.6);
  return (
    <Stage layout={layout}>
      <GlassCard>
        {content.emoji ? <EmojiBadge emoji={content.emoji} size={150} style={{ scale: String(0.6 + 0.4 * pop), opacity: pop }} /> : null}
        {content.kicker ? <Kicker style={rise(frame, start, fps)}>{content.kicker}</Kicker> : null}
        <h1 style={{ margin: 0, font: `700 ${size}px/1.02 ${pulso.font.display}`, letterSpacing: "-0.03em", color: pulso.color.ink, textWrap: "balance" }}>
          {words.map((word, index) => (
            <span key={index} style={{ display: "inline-block", marginRight: "0.24em", ...rise(frame, start + 4 + index * 3, fps, 30) }}>
              {word}
            </span>
          ))}
        </h1>
        {content.lead ? (
          <p style={{ margin: 0, font: `400 40px/1.4 ${pulso.font.text}`, color: pulso.color.muted, ...rise(frame, start + 10 + words.length * 3, fps) }}>{content.lead}</p>
        ) : null}
      </GlassCard>
    </Stage>
  );
};
