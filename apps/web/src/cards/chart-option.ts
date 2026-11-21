import type { Card } from "@jarvis/contracts";

type ChartCard = Extract<Card, { kind: "chart" }>;

const COLORS = ["#46e3ff", "#2b5cff", "#f5b841", "#8fefff", "#b07cff", "#ff7a90"];
const TEXT = "#e4f3ff";
const MUTED = "#8ca6c4";
const LINE = "rgba(70, 227, 255, 0.28)";
const GRID = "rgba(70, 227, 255, 0.1)";

function fade(color: string, from: number, to: number) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return {
    type: "linear",
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: `rgba(${r}, ${g}, ${b}, ${from})` },
      { offset: 1, color: `rgba(${r}, ${g}, ${b}, ${to})` },
    ],
  };
}

const axisStyle = {
  axisLine: { lineStyle: { color: LINE } },
  axisTick: { show: false },
  axisLabel: { color: MUTED },
  splitLine: { lineStyle: { color: GRID, type: "dashed" } },
};

/** ECharts options for a chart card, in the HUD palette. Pure data: no ECharts import. */
export function chartOption(card: ChartCard): Record<string, unknown> {
  const unit = card.unit ?? "";
  const legend = card.series.length > 1 ? { bottom: 0, textStyle: { color: MUTED }, icon: "roundRect" } : { show: false };
  const base = {
    backgroundColor: "transparent",
    color: COLORS,
    textStyle: { color: TEXT, fontFamily: "inherit" },
    animationDuration: 700,
    tooltip: {
      trigger: card.chart === "pie" ? "item" : "axis",
      backgroundColor: "rgba(5, 11, 24, 0.95)",
      borderColor: LINE,
      textStyle: { color: TEXT },
      valueFormatter: (value: number) => `${value}${unit}`,
    },
    legend,
  };

  if (card.chart === "pie") {
    const series = card.series[0];
    return {
      ...base,
      legend: { bottom: 0, textStyle: { color: MUTED }, icon: "circle" },
      series: [
        {
          type: "pie",
          name: series?.name,
          radius: ["46%", "72%"],
          center: ["50%", "45%"],
          itemStyle: { borderColor: "#050b18", borderWidth: 2 },
          label: { color: TEXT, formatter: "{d}%" },
          data: card.labels.map((label, i) => ({ name: label, value: series?.values[i] ?? 0 })),
        },
      ],
    };
  }

  const grid = { left: 8, right: 16, top: 16, bottom: card.series.length > 1 ? 32 : 8, containLabel: true };

  if (card.chart === "progress") {
    return {
      ...base,
      grid,
      xAxis: { type: "value", max: 100, ...axisStyle, axisLabel: { show: false } },
      yAxis: { type: "category", data: card.labels, inverse: true, ...axisStyle, splitLine: { show: false } },
      series: card.series.map((series, i) => ({
        type: "bar",
        name: series.name,
        data: series.values,
        barMaxWidth: 18,
        showBackground: true,
        backgroundStyle: { color: "rgba(70, 227, 255, 0.08)", borderRadius: 9 },
        itemStyle: { borderRadius: 9, color: COLORS[i % COLORS.length] },
        label: { show: true, position: "right", color: TEXT, formatter: "{c}%" },
      })),
    };
  }

  return {
    ...base,
    grid,
    xAxis: { type: "category", data: card.labels, boundaryGap: card.chart === "bar", ...axisStyle, splitLine: { show: false } },
    yAxis: { type: "value", ...axisStyle, axisLabel: { color: MUTED, formatter: `{value}${unit}` } },
    series: card.series.map((series, i) => {
      const color = COLORS[i % COLORS.length] as string;
      if (card.chart === "bar") {
        return { type: "bar", name: series.name, data: series.values, barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0], color: fade(color, 1, 0.35) } };
      }
      return {
        type: "line",
        name: series.name,
        data: series.values,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2 },
        ...(card.chart === "area" ? { areaStyle: { color: fade(color, 0.45, 0) } } : {}),
      };
    }),
  };
}
