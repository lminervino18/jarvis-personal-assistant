/** Visual tokens of the JARVIS HUD look (deep navy, cyan light, white type), shared by every video composition. */
export const hud = {
  color: {
    bg: "#02070d",
    bgGlow: "#06293a",
    panel: "rgba(5, 22, 33, 0.74)",
    panelStrong: "rgba(9, 38, 54, 0.9)",
    text: "#e8fbff",
    muted: "#8db2c3",
    accent: "#3fe0ff",
    accentStrong: "#8cf2ff",
    accentSoft: "rgba(63, 224, 255, 0.12)",
    line: "rgba(63, 224, 255, 0.3)",
    glow: "rgba(63, 224, 255, 0.55)",
    onAccent: "#00141c",
    good: "#4ade80",
    warn: "#fbbf24",
    bad: "#f87171",
  },
  font: {
    display: '"Space Grotesk", "Inter", system-ui, sans-serif',
    text: '"Inter", system-ui, sans-serif',
  },
  panel: {
    radius: 18,
    border: "1.5px solid rgba(63, 224, 255, 0.3)",
    shadow: "0 0 80px -30px rgba(63, 224, 255, 0.45), inset 0 0 60px rgba(63, 224, 255, 0.05)",
  },
  rise: { distance: 14, seconds: 0.8, staggerSeconds: 0.08, bezier: [0.2, 0.7, 0.2, 1] as const },
} as const;
