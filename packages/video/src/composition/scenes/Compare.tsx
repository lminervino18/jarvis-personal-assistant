import { useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../../tokens.js";
import { rise } from "../motion.js";
import { Emoji, Kicker, Pill } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

export const CompareScene: React.FC<SceneProps<"compare">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Stage layout={layout}>
      <div style={rise(frame, 0, fps)}>
        <Kicker>Comparación</Kicker>
        <h2 style={{ margin: "14px 0 0", font: `700 ${layout.vertical ? 74 : 68}px/1.02 ${pulso.font.display}`, letterSpacing: "-0.03em", color: pulso.color.ink, textWrap: "balance" }}>{content.title}</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: layout.vertical ? "1fr" : `repeat(${content.options.length}, minmax(0, 1fr))`, gap: layout.vertical ? 28 : 36 }}>
        {content.options.map((option, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
              padding: layout.vertical ? "36px 40px" : "44px 44px",
              borderRadius: 40,
              background: option.highlight ? pulso.color.white : "rgba(255, 255, 255, 0.86)",
              border: option.highlight ? `4px solid ${pulso.color.uv}` : "2px solid rgba(91, 43, 255, 0.18)",
              boxShadow: option.highlight ? "0 50px 120px -50px rgba(58, 18, 214, 0.6)" : "0 40px 100px -60px rgba(58, 18, 214, 0.4)",
              ...rise(frame, cueFrame(scene, index, fps), fps, 50),
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              {option.emoji ? <Emoji size={64}>{option.emoji}</Emoji> : null}
              <h3 style={{ margin: 0, flex: 1, font: `700 52px/1.05 ${pulso.font.display}`, letterSpacing: "-0.02em", color: pulso.color.ink }}>{option.label}</h3>
              {option.highlight ? <Pill style={{ background: pulso.color.uv, color: pulso.color.white, fontSize: 26, padding: "10px 20px" }}>Recomendada</Pill> : null}
            </div>
            {option.points.map((point, at) => (
              <p key={at} style={{ display: "flex", gap: 18, margin: 0, font: `400 34px/1.35 ${pulso.font.text}`, color: pulso.color.muted }}>
                <span style={{ flex: "none", width: 14, height: 14, marginTop: 16, borderRadius: "50%", background: pulso.color.uv }} />
                {point}
              </p>
            ))}
          </div>
        ))}
      </div>
    </Stage>
  );
};
