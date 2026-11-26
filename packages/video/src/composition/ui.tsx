import type { CSSProperties, ReactNode } from "react";
import { hud } from "../tokens.js";

const EMOJI_FONTS = '"Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';
const BRACKET = 34;

const Bracket: React.FC<{ x: "left" | "right"; y: "top" | "bottom" }> = ({ x, y }) => (
  <span
    style={{
      position: "absolute",
      [x]: -2,
      [y]: -2,
      width: BRACKET,
      height: BRACKET,
      [`border${y === "top" ? "Top" : "Bottom"}`]: `3px solid ${hud.color.accent}`,
      [`border${x === "left" ? "Left" : "Right"}`]: `3px solid ${hud.color.accent}`,
      borderRadius: `${y === "top" && x === "left" ? hud.panel.radius : 0}px ${y === "top" && x === "right" ? hud.panel.radius : 0}px ${y === "bottom" && x === "right" ? hud.panel.radius : 0}px ${y === "bottom" && x === "left" ? hud.panel.radius : 0}px`,
    }}
  />
);

/** A HUD panel: dark glass with a faint cyan edge and brighter corner brackets, like a readout on the suit's visor. */
export const Panel: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      position: "relative",
      display: "flex",
      flexDirection: "column",
      gap: 30,
      padding: "52px 52px",
      borderRadius: hud.panel.radius,
      border: hud.panel.border,
      background: hud.color.panel,
      boxShadow: hud.panel.shadow,
      ...style,
    }}
  >
    <Bracket x="left" y="top" />
    <Bracket x="right" y="top" />
    <Bracket x="left" y="bottom" />
    <Bracket x="right" y="bottom" />
    {children}
  </div>
);

export const Kicker: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <p style={{ display: "flex", alignItems: "center", gap: 14, margin: 0, font: `500 28px/1.1 ${hud.font.display}`, letterSpacing: "0.18em", textTransform: "uppercase", color: hud.color.accent, ...style }}>
    <span style={{ width: 12, height: 12, background: hud.color.accent, boxShadow: `0 0 16px ${hud.color.glow}` }} />
    {children}
  </p>
);

export const Emoji: React.FC<{ children: ReactNode; size: number; style?: CSSProperties }> = ({ children, size, style }) => (
  <span style={{ display: "inline-grid", placeItems: "center", fontFamily: EMOJI_FONTS, fontSize: size, lineHeight: 1, ...style }}>{children}</span>
);

export const EmojiBadge: React.FC<{ emoji: string; size: number; style?: CSSProperties }> = ({ emoji, size, style }) => (
  <div
    style={{
      display: "grid",
      placeItems: "center",
      width: size,
      height: size,
      borderRadius: "50%",
      border: `2px solid ${hud.color.line}`,
      background: hud.color.accentSoft,
      boxShadow: `0 0 40px -10px ${hud.color.glow}`,
      ...style,
    }}
  >
    <Emoji size={size * 0.52}>{emoji}</Emoji>
  </div>
);

export const Pill: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 28px",
      borderRadius: 999,
      border: `1.5px solid ${hud.color.line}`,
      background: hud.color.accentSoft,
      color: hud.color.accentStrong,
      font: `500 32px/1.2 ${hud.font.display}`,
      ...style,
    }}
  >
    {children}
  </span>
);

export const ActionButton: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 18,
      minHeight: 116,
      padding: "0 44px",
      borderRadius: hud.panel.radius,
      background: `linear-gradient(135deg, ${hud.color.accentStrong}, ${hud.color.accent})`,
      color: hud.color.onAccent,
      font: `700 40px/1.15 ${hud.font.display}`,
      textAlign: "center",
      boxShadow: `0 0 60px -14px ${hud.color.glow}`,
      ...style,
    }}
  >
    {children}
  </div>
);
