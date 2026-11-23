/** Adds dictated text after what is already written, separated by a single space. */
export function appendDictation(current: string, addition: string): string {
  if (!current.trim()) return addition;
  return /\s$/.test(current) ? `${current}${addition}` : `${current} ${addition}`;
}
