import type { CSSProperties, ReactNode } from "react";
import { pulso } from "../tokens.js";

const EMOJI_FONTS = '"Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';

export const GlassCard: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 30,
      padding: "52px 52px",
      borderRadius: pulso.card.radius * 1.6,
      border: "2px solid rgba(91, 43, 255, 0.18)",
      background: "rgba(255, 255, 255, 0.86)",
      boxShadow: "0 60px 140px -60px rgba(58, 18, 214, 0.45)",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Kicker: React.FC<{ children: ReactNode; style?: CSSProperties }> = ({ children, style }) => (
  <p style={{ margin: 0, font: `500 30px/1.1 ${pulso.font.display}`, letterSpacing: "0.1em", textTransform: "uppercase", color: pulso.color.uvDeep, ...style }}>{children}</p>
);

export const Emoji: React.FC<{ children: ReactNode; size: number; style?: CSSProperties }> = ({ children, size, style }) => (
  <span style={{ display: "inline-grid", placeItems: "center", fontFamily: EMOJI_FONTS, fontSize: size, lineHeight: 1, ...style }}>{children}</span>
);

export const EmojiBadge: React.FC<{ emoji: string; size: number; style?: CSSProperties }> = ({ emoji, size, style }) => (
  <div style={{ display: "grid", placeItems: "center", width: size, height: size, borderRadius: "50%", background: pulso.color.uvMist, ...style }}>
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
      background: pulso.color.uvMist,
      color: pulso.color.uvDeep,
      font: `500 32px/1.2 ${pulso.font.display}`,
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
      borderRadius: 34,
      background: `linear-gradient(135deg, ${pulso.color.uv}, ${pulso.color.uvDeep})`,
      color: pulso.color.white,
      font: `700 40px/1.15 ${pulso.font.display}`,
      textAlign: "center",
      boxShadow: "0 30px 70px -30px rgba(58, 18, 214, 0.7)",
      ...style,
    }}
  >
    {children}
  </div>
);
