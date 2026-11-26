import { useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../../tokens.js";
import { fitSize } from "../layout.js";
import { rise } from "../motion.js";
import { Panel, Kicker } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

export const IntroScene: React.FC<SceneProps<"intro">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const purposeAt = Math.max(cueFrame(scene, 0, fps), 12);
  const purpose = content.purpose.charAt(0).toUpperCase() + content.purpose.slice(1);
  return (
    <Stage layout={layout} style={{ justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, alignItems: layout.vertical ? "center" : "flex-start", ...rise(frame, 4, fps) }}>
        <p style={{ margin: 0, font: `700 ${layout.vertical ? 76 : 64}px/1 ${hud.font.display}`, letterSpacing: "0.32em", color: hud.color.text }}>J.A.R.V.IS</p>
        <Kicker style={{ ...rise(frame, 10, fps) }}>Asistente personal de {content.owner}</Kicker>
      </div>
      <Panel style={{ ...rise(frame, purposeAt, fps, 60), maxWidth: layout.vertical ? undefined : 1100, alignSelf: layout.vertical ? "stretch" : "flex-start" }}>
        <Kicker>Este mensaje es para</Kicker>
        <h1 style={{ margin: 0, font: `700 ${fitSize(purpose, layout.width - layout.side * 2 - 104, 3, 56, 92)}px/1.04 ${hud.font.display}`, letterSpacing: "-0.03em", color: hud.color.text, textWrap: "balance" }}>
          {purpose}
        </h1>
      </Panel>
    </Stage>
  );
};
