export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile of an unsorted sample; undefined for an empty sample. */
export function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

export function summarize(values: readonly number[]): LatencySummary | undefined {
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  if (p50 === undefined || p95 === undefined) return undefined;
  return { count: values.length, p50, p95, max: Math.max(...values) };
}
