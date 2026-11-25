const EDGE = 0.16;

function ramp(axis: "x" | "y", channel: "red" | "green"): string {
  const color = (value: number) => (channel === "red" ? `rgb(${value},0,0)` : `rgb(0,${value},0)`);
  const end = axis === "x" ? 'x2="1" y2="0"' : 'x2="0" y2="1"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" preserveAspectRatio="none"><linearGradient id="g" x1="0" y1="0" ${end}><stop offset="0" stop-color="${color(0)}"/><stop offset="${EDGE}" stop-color="${color(128)}"/><stop offset="${1 - EDGE}" stop-color="${color(128)}"/><stop offset="1" stop-color="${color(255)}"/></linearGradient><rect width="100" height="100" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const RAMP_X = ramp("x", "red");
const RAMP_Y = ramp("y", "green");

/**
 * The SVG lens that bends what is behind the glass near its edges, like iOS Liquid Glass. Only
 * Chromium applies SVG filters in `backdrop-filter`; the styles use it under the `refract` class.
 */
export function GlassLens() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <filter id="glass-lens" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
        <feImage href={RAMP_X} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="x" />
        <feImage href={RAMP_Y} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="y" />
        <feComposite in="x" in2="y" operator="arithmetic" k2="1" k3="1" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.06" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
