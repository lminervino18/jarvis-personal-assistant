import { useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../../tokens.js";
import { msToFrame, progressFrom, rise } from "../motion.js";
import { EmojiBadge, Panel } from "../ui.js";
import { Stage, type SceneProps } from "./shared.js";

function formatNumber(value: number, decimals: number): string {
  return value.toLocaleString("es-AR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export const StatScene: React.FC<SceneProps<"stat">> = ({ scene, content, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = msToFrame(scene.audio.startMs, fps);
  const counted = progressFrom(frame, start, fps, 1.4);
  const ring = content.suffix?.trim() === "%" ? Math.min(Math.max(content.value / 100, 0), 1) * counted : undefined;
  const text = `${content.prefix ?? ""}${formatNumber(content.value * counted, content.decimals)}${content.suffix ?? ""}`;
  const size = Math.min(layout.vertical ? 230 : 210, Math.floor(((layout.width - layout.side * 2 - 104) * 1.6) / Math.max(text.length, 3)));
  const radius = 210;
  const circumference = 2 * Math.PI * radius;
  return (
    <Stage layout={layout} style={{ alignItems: "center" }}>
      <Panel style={{ alignItems: "center", textAlign: "center", width: "100%", maxWidth: 1100 }}>
        {content.emoji ? <EmojiBadge emoji={content.emoji} size={140} style={rise(frame, 0, fps)} /> : null}
        <div style={{ position: "relative", display: "grid", placeItems: "center", minHeight: ring === undefined ? undefined : radius * 2 + 40 }}>
          {ring === undefined ? null : (
            <svg width={radius * 2 + 40} height={radius * 2 + 40} style={{ position: "absolute" }} aria-hidden="true">
              <circle cx={radius + 20} cy={radius + 20} r={radius} fill="none" stroke={hud.color.accentSoft} strokeWidth={26} />
              <circle
                cx={radius + 20}
                cy={radius + 20}
                r={radius}
                fill="none"
                stroke={hud.color.accent}
                strokeWidth={26}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - ring)}
                transform={`rotate(-90 ${radius + 20} ${radius + 20})`}
              />
            </svg>
          )}
          <p style={{ position: "relative", margin: 0, font: `700 ${ring === undefined ? size : Math.min(size, 150)}px/1 ${hud.font.display}`, letterSpacing: "-0.04em", color: hud.color.accent, fontVariantNumeric: "tabular-nums" }}>{text}</p>
        </div>
        <p style={{ margin: 0, font: `700 54px/1.1 ${hud.font.display}`, letterSpacing: "-0.02em", color: hud.color.text, textWrap: "balance", ...rise(frame, start + 10, fps) }}>{content.label}</p>
        {content.context ? <p style={{ margin: 0, font: `400 36px/1.4 ${hud.font.text}`, color: hud.color.muted, ...rise(frame, start + 18, fps) }}>{content.context}</p> : null}
      </Panel>
    </Stage>
  );
};
