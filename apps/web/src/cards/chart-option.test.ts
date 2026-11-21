import { describe, expect, it } from "vitest";
import { chartOption } from "./chart-option.js";

const base = { kind: "chart" as const, title: "Prueba", labels: ["a", "b"], series: [{ name: "Serie", values: [1, 2] }] };

describe("chartOption", () => {
  it("maps bars and lines onto a category axis with the unit in the value axis", () => {
    const bar = chartOption({ ...base, chart: "bar", unit: "%" }) as { xAxis: { data: string[] }; yAxis: { axisLabel: { formatter: string } }; series: { type: string }[] };
    expect(bar.xAxis.data).toEqual(["a", "b"]);
    expect(bar.yAxis.axisLabel.formatter).toBe("{value}%");
    expect(bar.series[0]?.type).toBe("bar");
    const area = chartOption({ ...base, chart: "area" }) as { series: { type: string; areaStyle?: unknown }[] };
    expect(area.series[0]).toMatchObject({ type: "line" });
    expect(area.series[0]?.areaStyle).toBeDefined();
  });

  it("builds a donut from the first series and horizontal percentage bars for progress", () => {
    const pie = chartOption({ ...base, chart: "pie" }) as { series: { type: string; data: { name: string; value: number }[] }[] };
    expect(pie.series[0]).toMatchObject({ type: "pie", data: [{ name: "a", value: 1 }, { name: "b", value: 2 }] });
    const progress = chartOption({ ...base, chart: "progress" }) as { xAxis: { max: number }; yAxis: { data: string[] } };
    expect(progress.xAxis.max).toBe(100);
    expect(progress.yAxis.data).toEqual(["a", "b"]);
  });

  it("shows a legend only when there are several series", () => {
    expect((chartOption({ ...base, chart: "line" }) as { legend: { show?: boolean } }).legend.show).toBe(false);
    const two = chartOption({ ...base, chart: "line", series: [...base.series, { name: "Otra", values: [3, 4] }] }) as { legend: { show?: boolean } };
    expect(two.legend.show).toBeUndefined();
  });
});
