import { hud } from "../tokens.js";

const TICKS = 72;
const BARS = 64;

function polar(radius: number, degrees: number): [number, number] {
  const angle = ((degrees - 90) * Math.PI) / 180;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function arc(radius: number, from: number, to: number): string {
  const [x1, y1] = polar(radius, from);
  const [x2, y2] = polar(radius, to);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** A steady pseudo-random wobble per bar, so the voice ring moves like a level meter without randomness between frames. */
function wobble(index: number, seconds: number): number {
  return 0.5 + 0.5 * Math.sin(index * 12.9898 + seconds * 9.3) * Math.cos(index * 4.1414 + seconds * 6.1);
}

/**
 * JARVIS's core as an SVG HUD: rotating segmented rings, a tick crown, and a reactor at the center
 * whose glow and voice ring follow `level`, how much the narration is speaking now (0 to 1).
 * Drawn from the time alone, so the preview and the render draw exactly the same frame.
 */
export const Core: React.FC<{ size: number; seconds: number; level: number }> = ({ size, seconds, level }) => {
  const r = size / 2;
  const stroke = Math.max(1.2, size / 380);
  const spin = seconds * 14;
  const counter = -seconds * 22;
  const glow = 0.55 + 0.45 * level;
  const dash = (r * 0.96 * Math.PI * 2) / 96;
  return (
    <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} style={{ overflow: "visible" }} aria-hidden="true">
      <defs>
        <radialGradient id="core-halo">
          <stop offset="0" stopColor={hud.color.accent} stopOpacity={0.28 * glow} />
          <stop offset="0.55" stopColor={hud.color.accent} stopOpacity={0.08 * glow} />
          <stop offset="1" stopColor={hud.color.accent} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="core-heart">
          <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="0.35" stopColor={hud.color.accentStrong} stopOpacity="0.95" />
          <stop offset="1" stopColor={hud.color.accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle r={r * 1.1} fill="url(#core-halo)" />

      <g transform={`rotate(${spin})`}>
        <circle r={r * 0.96} fill="none" stroke={hud.color.accent} strokeWidth={stroke * 2} strokeDasharray={`${dash} ${dash}`} strokeOpacity="0.45" />
      </g>
      <circle r={r * 0.9} fill="none" stroke={hud.color.accent} strokeWidth={stroke * 0.6} strokeOpacity="0.35" />
      {Array.from({ length: TICKS }, (_, index) => {
        const long = index % 6 === 0;
        const [x1, y1] = polar(r * (long ? 0.8 : 0.83), (index * 360) / TICKS);
        const [x2, y2] = polar(r * 0.87, (index * 360) / TICKS);
        return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hud.color.accent} strokeWidth={stroke * (long ? 1.4 : 0.7)} strokeOpacity={long ? 0.8 : 0.4} />;
      })}

      <g transform={`rotate(${counter})`}>
        {[0, 120, 240].map((start) => (
          <path key={start} d={arc(r * 0.7, start, start + 78)} fill="none" stroke={hud.color.accentStrong} strokeWidth={stroke * 3} strokeLinecap="round" strokeOpacity="0.85" />
        ))}
      </g>
      <g transform={`rotate(${spin * 1.6})`}>
        {[40, 220].map((start) => (
          <path key={start} d={arc(r * 0.62, start, start + 110)} fill="none" stroke={hud.color.accent} strokeWidth={stroke} strokeOpacity="0.6" />
        ))}
      </g>

      {Array.from({ length: BARS }, (_, index) => {
        const degrees = (index * 360) / BARS + seconds * 6;
        const length = r * (0.025 + 0.11 * level * wobble(index, seconds));
        const [x1, y1] = polar(r * 0.46, degrees);
        const [x2, y2] = polar(r * 0.46 + length, degrees);
        return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hud.color.accentStrong} strokeWidth={stroke * 1.6} strokeLinecap="round" strokeOpacity={0.35 + 0.6 * level} />;
      })}

      <circle r={r * 0.4} fill="none" stroke={hud.color.accent} strokeWidth={stroke} strokeOpacity="0.5" />
      <g transform={`rotate(${-spin * 0.8})`}>
        {Array.from({ length: 10 }, (_, index) => (
          <path key={index} d={arc(r * 0.3, index * 36 + 4, index * 36 + 30)} fill="none" stroke={hud.color.accentStrong} strokeWidth={stroke * 5} strokeOpacity={0.45 + 0.4 * glow} />
        ))}
      </g>
      <circle r={r * (0.2 + 0.035 * level)} fill="url(#core-heart)" opacity={glow} />
      <circle r={r * 0.1} fill="#ffffff" fillOpacity={0.55 + 0.4 * level} />
    </svg>
  );
};
