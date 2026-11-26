import { useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../../tokens.js";
import { rise } from "../motion.js";
import { Panel, Pill } from "../ui.js";
import { cueFrame, Stage, type SceneProps } from "./shared.js";

const OUTCOMES = {
  done: { label: "✅ Listo", background: "rgba(74, 222, 128, 0.14)", color: hud.color.good },
  partial: { label: "⚠️ A medias", background: "rgba(251, 191, 36, 0.14)", color: hud.color.warn },
  failed: { label: "❌ No se pudo", background: "rgba(248, 113, 113, 0.14)", color: hud.color.bad },
} as const;

export const ResultScene: React.FC<SceneProps<"result">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const outcome = OUTCOMES[content.outcome];
  return (
    <Stage layout={layout}>
      <Panel>
        <Pill style={{ alignSelf: "flex-start", background: outcome.background, color: outcome.color, ...rise(frame, 0, fps) }}>{outcome.label}</Pill>
        <h2 style={{ margin: 0, font: `700 ${layout.vertical ? 76 : 68}px/1.02 ${hud.font.display}`, letterSpacing: "-0.03em", color: hud.color.text, textWrap: "balance", ...rise(frame, 4, fps) }}>{content.title}</h2>
        {content.facts.length ? (
          <dl style={{ display: "grid", gridTemplateColumns: layout.vertical && content.facts.length > 2 ? "repeat(2, minmax(0, 1fr))" : `repeat(${Math.min(content.facts.length, 4)}, minmax(0, 1fr))`, gap: "34px 30px", margin: 0, paddingTop: 30, borderTop: `3px solid ${hud.color.text}` }}>
            {content.facts.map((fact, index) => (
              <div key={index} style={{ minWidth: 0, ...rise(frame, cueFrame(scene, index, fps), fps, 30) }}>
                <dt style={{ font: `500 26px/1.2 ${hud.font.text}`, letterSpacing: "0.12em", textTransform: "uppercase", color: hud.color.muted }}>{fact.label}</dt>
                <dd style={{ margin: "10px 0 0", font: `700 44px/1.15 ${hud.font.display}`, color: hud.color.text, overflowWrap: "anywhere" }}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Panel>
    </Stage>
  );
};
