import { pulso } from "../tokens.js";

const MERIDIANS = 14;
const PARALLELS = 9;
const SAMPLES = 48;

type Point = [number, number, number];

function deform([x, y, z]: Point, t: number): Point {
  const k = 1 + 0.06 * Math.sin(x * 1.8 + t * 1.3) * Math.cos(y * 1.6 + t);
  return [x * k, y * k, z * k];
}

function rotate([x, y, z]: Point, angle: number, tilt: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx = x * cos + z * sin;
  const rz = -x * sin + z * cos;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return [rx, y * ct - rz * st, y * st + rz * ct];
}

function path(points: Point[], radius: number): string {
  return points.map(([x, y], index) => `${index ? "L" : "M"}${(x * radius).toFixed(1)} ${(-y * radius).toFixed(1)}`).join("");
}

/**
 * The pages' breathing ultraviolet sphere, drawn as an SVG wireframe from the time alone, so
 * the preview and the render draw exactly the same frame.
 */
export const Orb: React.FC<{ size: number; seconds: number }> = ({ size, seconds }) => {
  const unit = 2.2;
  const radius = size / 2 / 1.08;
  const angle = seconds * 0.25;
  const tilt = 0.25 + Math.sin(seconds * 0.2) * 0.2;
  const line = (point: Point) => rotate(deform(point, seconds), angle, tilt);
  const lines: string[] = [];
  for (let m = 0; m < MERIDIANS; m++) {
    const phi = (m / MERIDIANS) * Math.PI * 2;
    const points: Point[] = [];
    for (let s = 0; s <= SAMPLES; s++) {
      const theta = (s / SAMPLES) * Math.PI;
      points.push(line([unit * Math.sin(theta) * Math.cos(phi), unit * Math.cos(theta), unit * Math.sin(theta) * Math.sin(phi)]));
    }
    lines.push(path(points, radius / unit));
  }
  for (let p = 1; p < PARALLELS; p++) {
    const theta = (p / PARALLELS) * Math.PI;
    const points: Point[] = [];
    for (let s = 0; s <= SAMPLES; s++) {
      const phi = (s / SAMPLES) * Math.PI * 2;
      points.push(line([unit * Math.sin(theta) * Math.cos(phi), unit * Math.cos(theta), unit * Math.sin(theta) * Math.sin(phi)]));
    }
    lines.push(path(points, radius / unit));
  }
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} style={{ overflow: "visible" }} aria-hidden="true">
      <defs>
        <radialGradient id="orb-glow">
          <stop offset="0" stopColor={pulso.color.glow} stopOpacity="0.55" />
          <stop offset="1" stopColor={pulso.color.glow} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle r={radius * 1.05} fill="url(#orb-glow)" />
      <circle r={radius * 0.77} fill={pulso.color.glow} fillOpacity="0.3" />
      {lines.map((d, index) => (
        <path key={index} d={d} fill="none" stroke={pulso.color.uv} strokeOpacity="0.38" strokeWidth={Math.max(1, size / 420)} />
      ))}
    </svg>
  );
};
