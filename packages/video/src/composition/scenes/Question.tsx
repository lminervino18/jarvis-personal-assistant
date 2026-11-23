import { useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../../tokens.js";
import { fitSize } from "../layout.js";
import { msToFrame, rise } from "../motion.js";
import { ActionButton, Emoji, GlassCard, Kicker } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

export const QuestionScene: React.FC<SceneProps<"question">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lastCue = cueFrame(scene, content.options.length - 1, fps);
  const hintAt = Math.max(lastCue + 12, msToFrame(scene.audio.startMs + scene.audio.durationMs * 0.7, fps));
  return (
    <Stage layout={layout}>
      <GlassCard>
        <Kicker style={rise(frame, 0, fps)}>Una pregunta</Kicker>
        <h2 style={{ margin: 0, font: `700 ${fitSize(content.question, layout.width - layout.side * 2 - 104, 3, 56, 84)}px/1.05 ${pulso.font.display}`, letterSpacing: "-0.03em", color: pulso.color.ink, textWrap: "balance", ...rise(frame, 4, fps) }}>
          {content.question}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: layout.vertical ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 12, padding: 12, borderRadius: 40, background: pulso.color.uvMist }}>
          {content.options.map((option, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 22,
                minHeight: 104,
                padding: "0 34px",
                borderRadius: 30,
                background: pulso.color.white,
                color: pulso.color.uvDeep,
                font: `500 42px/1.15 ${pulso.font.display}`,
                boxShadow: "0 12px 34px -16px rgba(58, 18, 214, 0.5)",
                ...rise(frame, cueFrame(scene, index, fps), fps, 26),
              }}
            >
              {option.emoji ? <Emoji size={50}>{option.emoji}</Emoji> : <span style={{ font: `700 36px/1 ${pulso.font.display}`, color: pulso.color.uv }}>{String.fromCharCode(65 + index)}</span>}
              {option.label}
            </div>
          ))}
        </div>
        <ActionButton style={rise(frame, hintAt, fps, 30)}>
          <Emoji size={46}>💬</Emoji>
          {content.replyHint}
        </ActionButton>
      </GlassCard>
    </Stage>
  );
};
