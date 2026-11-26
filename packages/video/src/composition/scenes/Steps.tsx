import { useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../../tokens.js";
import { progressFrom, rise } from "../motion.js";
import { Emoji, Kicker } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

const NODE = 104;

export const StepsScene: React.FC<SceneProps<"steps">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const gap = layout.vertical ? 56 : 30;
  return (
    <Stage layout={layout}>
      <div style={rise(frame, 0, fps)}>
        <Kicker>Paso a paso</Kicker>
        <h2 style={{ margin: "14px 0 0", font: `700 ${layout.vertical ? 74 : 66}px/1.02 ${hud.font.display}`, letterSpacing: "-0.03em", color: hud.color.text, textWrap: "balance" }}>{content.title}</h2>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap }}>
        {content.steps.map((step, index) => {
          const at = cueFrame(scene, index, fps);
          const next = index + 1 < content.steps.length ? cueFrame(scene, index + 1, fps) : undefined;
          const drawn = next === undefined ? 0 : progressFrom(frame, at + 6, fps, Math.max(0.4, (next - at - 6) / fps));
          return (
            <div key={index} style={{ position: "relative", display: "flex", alignItems: "center", gap: 36 }}>
              {next === undefined ? null : (
                <div style={{ position: "absolute", left: NODE / 2 - 3, top: NODE, width: 6, height: gap, borderRadius: 3, background: hud.color.accentSoft }}>
                  <div style={{ width: 6, height: `${drawn * 100}%`, borderRadius: 3, background: hud.color.accent }} />
                </div>
              )}
              <div
                style={{
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  width: NODE,
                  height: NODE,
                  borderRadius: "50%",
                  background: frame >= at ? `linear-gradient(135deg, ${hud.color.accent}, ${hud.color.accentStrong})` : hud.color.accentSoft,
                  color: hud.color.onAccent,
                  font: `700 46px/1 ${hud.font.display}`,
                  scale: String(0.7 + 0.3 * progressFrom(frame, at, fps, 0.5)),
                }}
              >
                {step.emoji ? <Emoji size={50}>{step.emoji}</Emoji> : index + 1}
              </div>
              <p style={{ margin: 0, flex: 1, font: `500 ${layout.vertical ? 52 : 44}px/1.2 ${hud.font.display}`, color: hud.color.text, ...rise(frame, at, fps, 30) }}>{step.text}</p>
            </div>
          );
        })}
      </div>
    </Stage>
  );
};
