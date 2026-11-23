/** Visual tokens of the "Pulso" page style (white, ultraviolet and black), shared by every video composition. */
export const pulso = {
  color: {
    white: "#ffffff",
    ink: "#0b0a12",
    uv: "#5b2bff",
    uvDeep: "#3a12d6",
    uvMist: "#f1ecff",
    muted: "#5d5873",
    line: "#e4e0f0",
    glow: "#c9b8ff",
  },
  font: {
    display: '"Space Grotesk", "Inter", system-ui, sans-serif',
    text: '"Inter", system-ui, sans-serif',
  },
  card: {
    radius: 28,
    border: "1px solid rgba(91, 43, 255, 0.18)",
    background: "rgba(255, 255, 255, 0.8)",
    shadow: "0 30px 80px -30px rgba(58, 18, 214, 0.35)",
  },
  pill: { radius: 999 },
  rise: { distance: 14, seconds: 0.8, staggerSeconds: 0.08, bezier: [0.2, 0.7, 0.2, 1] as const },
} as const;
