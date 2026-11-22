export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Keeps items from the chosen end of the list while their serialized size fits the budget. */
export function withinBudget<T>(items: readonly T[], budget: number, keep: "newest" | "oldest" = "newest"): { kept: T[]; omitted: number } {
  const ordered = keep === "newest" ? [...items].reverse() : [...items];
  const kept: T[] = [];
  let used = 0;
  for (const item of ordered) {
    used += JSON.stringify(item).length;
    if (kept.length > 0 && used > budget) break;
    kept.push(item);
  }
  return { kept: keep === "newest" ? kept.reverse() : kept, omitted: items.length - kept.length };
}
