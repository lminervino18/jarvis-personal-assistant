import { useCurrentFrame, useVideoConfig } from "remotion";
import { hud } from "../tokens.js";
import type { CaptionPage } from "../timeline.js";
import type { Layout } from "./layout.js";

/** Burned-in subtitles from the real word timings: one short phrase at a time, the word being said lit in cyan. */
export const Captions: React.FC<{ pages: CaptionPage[]; layout: Layout }> = ({ pages, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const page = pages.find((item) => item.startMs <= ms && ms < item.endMs);
  if (!page) return null;
  const shown = Math.min(1, (ms - page.startMs) / 120);
  const active = page.words.findLastIndex((word) => word.startMs <= ms);
  return (
    <div style={{ position: "absolute", left: layout.side, right: layout.side, bottom: layout.vertical ? 150 : 60, display: "flex", justifyContent: "center" }}>
      <p
        style={{
          margin: 0,
          maxWidth: layout.vertical ? 900 : 1300,
          padding: "18px 34px",
          borderRadius: hud.panel.radius,
          background: "rgba(2, 10, 16, 0.84)",
          border: hud.panel.border,
          boxShadow: "0 0 50px -20px rgba(63, 224, 255, 0.5)",
          font: `700 ${layout.vertical ? 50 : 44}px/1.25 ${hud.font.display}`,
          color: hud.color.text,
          textAlign: "center",
          opacity: shown,
          translate: `0px ${(1 - shown) * 10}px`,
        }}
      >
        {page.words.map((word, index) => (
          <span key={index} style={{ color: index === active ? hud.color.accent : hud.color.text, textShadow: index === active ? `0 0 18px ${hud.color.glow}` : undefined }}>
            {index ? " " : ""}
            {word.text}
          </span>
        ))}
      </p>
    </div>
  );
};
