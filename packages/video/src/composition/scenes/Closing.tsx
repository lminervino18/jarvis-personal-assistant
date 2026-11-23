import { useCurrentFrame, useVideoConfig } from "remotion";
import { pulso } from "../../tokens.js";
import { fitSize } from "../layout.js";
import { rise } from "../motion.js";
import { ActionButton, EmojiBadge, Kicker } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

export const ClosingScene: React.FC<SceneProps<"closing">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actionAt = cueFrame(scene, 0, fps);
  return (
    <Stage layout={layout} style={{ alignItems: "center", textAlign: "center", justifyContent: "flex-end", gap: 44 }}>
      {content.emoji ? <EmojiBadge emoji={content.emoji} size={170} style={rise(frame, 0, fps)} /> : null}
      <h2 style={{ margin: 0, font: `700 ${fitSize(content.title, layout.width - layout.side * 2, 3, 64, 104)}px/1.02 ${pulso.font.display}`, letterSpacing: "-0.03em", color: pulso.color.ink, textWrap: "balance", ...rise(frame, 4, fps) }}>
        {content.title}
      </h2>
      <ActionButton style={{ alignSelf: "stretch", ...rise(frame, actionAt, fps, 30) }}>{content.action}</ActionButton>
      {content.link ? <p style={{ margin: 0, font: `500 40px/1.2 ${pulso.font.display}`, color: pulso.color.uvDeep, ...rise(frame, actionAt + 8, fps) }}>{content.link}</p> : null}
      <Kicker style={{ color: pulso.color.muted, ...rise(frame, actionAt + 14, fps) }}>Jarvis · asistente personal de {layout.owner}</Kicker>
    </Stage>
  );
};
