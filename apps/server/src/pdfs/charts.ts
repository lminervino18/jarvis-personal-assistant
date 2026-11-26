import type { PdfBlock } from "@jarvis/contracts";

export type ChartBlock = Extract<PdfBlock, { type: "chart" }>;

export const CHART_COLORS = ["#0891b2", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444"] as const;
const INK = "#0f172a";
const MUTED = "#64748b";
const GRID = "#e2e8f0";
const FONT = 'font-family="Helvetica"';

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function short(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** A round step for an axis at or above `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((factor) => raw <= factor * power) ?? 10) * power;
}

/**
 * The axis for some values in four round steps. Bars start at zero so their heights compare;
 * lines fit the values, so a change from 142 to 220 does not look flat.
 */
export function axisRange(values: number[], fromZero: boolean): { min: number; max: number; step: number } {
  const low = Math.min(...values);
  const high = Math.max(...values);
  let min = fromZero ? Math.min(0, low) : low - (high - low) * 0.15;
  if (!fromZero && low >= 0) min = Math.max(0, min);
  let max = fromZero ? Math.max(0, high) : high + (high - low) * 0.15;
  if (max === min) max = min + 1;
  const step = niceStep((max - min) / 4);
  min = Math.floor(min / step) * step;
  max = min + step * 4;
  while (max < high) max += step;
  return { min, max, step };
}

/** A value as people read it: Argentine separators, currencies before the number and other units after. */
export function formatValue(value: number, unit?: string): string {
  const number = value.toLocaleString("es-AR", { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 });
  if (!unit) return number;
  return /[$€£¥]/.test(unit) ? `${unit} ${number}` : unit === "%" ? `${number}%` : `${number} ${unit}`;
}

function legend(series: ChartBlock["series"], width: number): string {
  let x = 0;
  const items = series.map((item, index) => {
    const label = short(item.name, 22);
    const svg = `<rect x="${x}" y="0" width="9" height="9" rx="2" fill="${CHART_COLORS[index]}"/><text x="${x + 13}" y="8" font-size="9" fill="${MUTED}" ${FONT}>${escape(label)}</text>`;
    x += 22 + label.length * 5.2;
    return svg;
  });
  return `<g transform="translate(${Math.max(0, (width - x) / 2)} 0)">${items.join("")}</g>`;
}

function axes(chart: ChartBlock, width: number, height: number): { svg: string; x: (index: number) => number; y: (value: number) => number; slot: number; top: number; bottom: number } {
  const top = chart.series.length > 1 ? 26 : 12;
  const left = 46;
  const bottom = height - (chart.labels.length > 8 ? 52 : 30);
  const right = width - 10;
  const { min, max, step } = axisRange(
    chart.series.flatMap((item) => item.values),
    chart.kind === "bar",
  );
  const y = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const slot = (right - left) / chart.labels.length;
  const x = (index: number) => left + slot * (index + 0.5);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + step * index);
  const grid = ticks
    .map((tick) => `<line x1="${left}" x2="${right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${GRID}" stroke-width="0.8"/><text x="${left - 6}" y="${(y(tick) + 3).toFixed(1)}" font-size="8" text-anchor="end" fill="${MUTED}" ${FONT}>${escape(formatValue(tick, chart.unit))}</text>`)
    .join("");
  const rotate = chart.labels.length > 8;
  const labels = chart.labels
    .map((label, index) =>
      rotate
        ? `<text x="${x(index).toFixed(1)}" y="${bottom + 12}" font-size="8" text-anchor="end" fill="${MUTED}" transform="rotate(-35 ${x(index).toFixed(1)} ${bottom + 12})" ${FONT}>${escape(short(label, 16))}</text>`
        : `<text x="${x(index).toFixed(1)}" y="${bottom + 15}" font-size="9" text-anchor="middle" fill="${MUTED}" ${FONT}>${escape(short(label, Math.max(6, Math.floor(slot / 5))))}</text>`,
    )
    .join("");
  return { svg: grid + labels + (chart.series.length > 1 ? legend(chart.series, width) : ""), x, y, slot, top, bottom };
}

function bars(chart: ChartBlock, width: number, height: number): string {
  const frame = axes(chart, width, height);
  const groups = chart.series.length;
  const barWidth = Math.min(46, (frame.slot * 0.72) / groups);
  const showValues = chart.labels.length * groups <= 16;
  const zero = frame.y(0);
  const rects = chart.series.flatMap((item, seriesIndex) =>
    item.values.slice(0, chart.labels.length).map((value, index) => {
      const x = frame.x(index) - (barWidth * groups) / 2 + barWidth * seriesIndex;
      const top = Math.min(frame.y(value), zero);
      const size = Math.max(0.5, Math.abs(frame.y(value) - zero));
      const label = showValues ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(top - 4).toFixed(1)}" font-size="8" text-anchor="middle" fill="${INK}" ${FONT}>${escape(formatValue(value, chart.unit))}</text>` : "";
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${(barWidth - 2).toFixed(1)}" height="${size.toFixed(1)}" rx="2" fill="${CHART_COLORS[seriesIndex]}"/>${label}`;
    }),
  );
  return frame.svg + rects.join("");
}

function lines(chart: ChartBlock, width: number, height: number): string {
  const frame = axes(chart, width, height);
  const paths = chart.series.map((item, seriesIndex) => {
    const points = item.values.slice(0, chart.labels.length).map((value, index) => [frame.x(index), frame.y(value)] as const);
    const color = CHART_COLORS[seriesIndex];
    const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color}"/>`).join("");
    return `<polyline points="${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${dots}`;
  });
  return frame.svg + paths.join("");
}

function pie(chart: ChartBlock, width: number, height: number): string {
  const values = (chart.series[0]?.values ?? []).slice(0, chart.labels.length).map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const radius = height / 2 - 14;
  const cx = radius + 14;
  const cy = height / 2;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const sweep = (value / total) * Math.PI * 2;
    const [x1, y1] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
    angle += sweep;
    const [x2, y2] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
    const color = CHART_COLORS[index % CHART_COLORS.length];
    if (sweep >= Math.PI * 2 - 1e-6) return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`;
    return `<path d="M${cx} ${cy}L${x1.toFixed(1)} ${y1.toFixed(1)}A${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}Z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`;
  });
  const legendX = cx + radius + 28;
  const rows = chart.labels.slice(0, values.length).map((label, index) => {
    const y = cy - (values.length * 18) / 2 + index * 18;
    const share = Math.round(((values[index] ?? 0) / total) * 100);
    return `<rect x="${legendX}" y="${y}" width="10" height="10" rx="2" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/><text x="${legendX + 16}" y="${y + 9}" font-size="10" fill="${INK}" ${FONT}>${escape(short(label, Math.floor((width - legendX - 60) / 5.5)))}</text><text x="${width - 4}" y="${y + 9}" font-size="10" text-anchor="end" fill="${MUTED}" ${FONT}>${share}%</text>`;
  });
  return slices.join("") + rows.join("");
}

/** A chart drawn as SVG for the PDF: bars, lines or a pie, in the document's few colors. */
export function chartSvg(chart: ChartBlock, width = 500, height = 250): string {
  const body = chart.kind === "pie" ? pie(chart, width, height) : chart.kind === "line" ? lines(chart, width, height) : bars(chart, width, height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}
