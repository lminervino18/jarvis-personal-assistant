import type { Card } from "@jarvis/contracts";
import { useEffect, useRef, useState } from "react";
import { chartOption } from "./chart-option.js";

type ChartCardData = Extract<Card, { kind: "chart" }>;

/** A chart drawn with ECharts, loaded only when a chart card appears. */
export function ChartCard({ card }: { card: ChartCardData }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    import("./echarts.js")
      .then(({ init }) => {
        if (disposed) return;
        const chart = init(element, undefined, { renderer: "canvas" });
        chart.setOption(chartOption(card));
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(element);
        cleanup = () => {
          observer.disconnect();
          chart.dispose();
        };
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [card]);

  const height = card.chart === "progress" ? Math.min(60 + card.labels.length * 34, 420) : 240;
  return (
    <section className="card card-chart" aria-label={`Gráfico: ${card.title}`}>
      <p className="card-kicker">Gráfico</p>
      <h3 className="card-title">{card.title}</h3>
      {failed ? (
        <p className="card-meta">No se pudo dibujar el gráfico.</p>
      ) : (
        <div ref={box} className="chart-box" style={{ height }} role="img" aria-label={card.series.map((series) => `${series.name}: ${series.values.join(", ")}`).join("; ")} />
      )}
      {card.note && <p className="card-meta">{card.note}</p>}
    </section>
  );
}
