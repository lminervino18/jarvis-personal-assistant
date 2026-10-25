const MIN_CHUNK_CHARS = 10;
const FIRST_CHUNK_SPLIT_CHARS = 60;
const LONG_SENTENCE_CHARS = 180;
const LATER_SPLIT_MIN_INDEX = 60;
const FENCE = "```";
const TERMINATORS = ".!?…";
const CLOSERS = "\"'»”’)]}*_";

const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "sres", "dr", "dra", "drs", "lic", "ing", "arq", "prof", "profa", "av", "avda",
  "pág", "págs", "núm", "vs", "ej", "aprox", "cap", "dpto", "depto", "tel", "ud", "uds", "vd", "vds",
  "gral", "cnel", "pte", "ee.uu", "s.a", "a.m", "p.m", "st", "mr", "mrs", "ms",
]);

/**
 * Splits streaming Spanish text into speakable chunks. A boundary needs one character of
 * lookahead, so the tail of the stream is released by flush().
 */
export class SentenceChunker {
  private buffer = "";
  private carry = "";
  private inFence = false;
  private emitted = 0;

  push(text: string): string[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): string[] {
    const chunks = this.drain(true);
    const rest = [this.carry, this.inFence ? "" : this.buffer].join(" ").trim();
    this.reset();
    if (rest) chunks.push(rest);
    return chunks;
  }

  reset(): void {
    this.buffer = "";
    this.carry = "";
    this.inFence = false;
    this.emitted = 0;
  }

  private drain(final: boolean): string[] {
    const chunks: string[] = [];
    for (;;) {
      if (this.inFence && !this.skipFence()) break;
      this.buffer = this.buffer.replace(/^\s+/, "");
      const fenceStart = this.buffer.indexOf(FENCE);
      const region = fenceStart === -1 ? this.buffer : this.buffer.slice(0, fenceStart);
      let end = findBoundary(region, final && fenceStart === -1);
      if (end === -1 && fenceStart !== -1) end = fenceStart;
      if (end === -1) end = this.findEarlySplit(region);
      if (end === -1) break;
      this.take(end, chunks);
      if (end === fenceStart) {
        this.buffer = this.buffer.slice(FENCE.length);
        this.inFence = true;
      }
    }
    return chunks;
  }

  private skipFence(): boolean {
    const close = this.buffer.indexOf(FENCE);
    if (close === -1) {
      this.buffer = this.buffer.slice(-FENCE.length);
      return false;
    }
    this.buffer = this.buffer.slice(close + FENCE.length);
    this.inFence = false;
    return true;
  }

  private take(end: number, chunks: string[]): void {
    const candidate = `${this.carry} ${this.buffer.slice(0, end)}`.trim();
    this.buffer = this.buffer.slice(end);
    if (candidate.length < MIN_CHUNK_CHARS) {
      this.carry = candidate;
      return;
    }
    this.carry = "";
    this.emitted++;
    chunks.push(candidate);
  }

  private findEarlySplit(region: string): number {
    const first = this.emitted === 0 && this.carry === "";
    if (region.length < (first ? FIRST_CHUNK_SPLIT_CHARS : LONG_SENTENCE_CHARS)) return -1;
    const minIndex = first ? MIN_CHUNK_CHARS : LATER_SPLIT_MIN_INDEX;
    const pattern = /[,;:]\s/g;
    for (let match = pattern.exec(region); match; match = pattern.exec(region)) {
      if (match.index + 1 >= minIndex) return match.index + 1;
    }
    return -1;
  }
}

function findBoundary(text: string, final: boolean): number {
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\n") return i + 1;
    if (!TERMINATORS.includes(char)) continue;
    const end = endOfTerminator(text, i);
    const verdict = judgeTerminator(text, i, end, final);
    if (verdict === "wait") return -1;
    if (verdict === "boundary") return end;
    i = end - 1;
  }
  return -1;
}

function endOfTerminator(text: string, start: number): number {
  let end = start;
  while (end < text.length && TERMINATORS.includes(text[end] as string)) end++;
  while (end < text.length && CLOSERS.includes(text[end] as string)) end++;
  return end;
}

function judgeTerminator(text: string, start: number, end: number, final: boolean): "boundary" | "skip" | "wait" {
  if (end >= text.length) return final ? "boundary" : "wait";
  if (!/\s/.test(text[end] as string)) return "skip";
  if (/[!?]/.test(text.slice(start, end))) return "boundary";
  const gap = /^\s*/.exec(text.slice(end))?.[0] ?? "";
  if (gap.includes("\n")) return "boundary";
  const next = text[end + gap.length];
  if (next === undefined) return final ? "boundary" : "wait";
  if (/\p{Ll}/u.test(next)) return "skip";
  return isAbbreviation(text, start) ? "skip" : "boundary";
}

function isAbbreviation(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== "." || text[dotIndex + 1] === ".") return false;
  let start = dotIndex;
  while (start > 0 && /[\p{L}\d.]/u.test(text[start - 1] as string)) start--;
  const token = text.slice(start, dotIndex);
  const lineStart = start === 0 || text[start - 1] === "\n";
  if (/^\d+$/.test(token)) return lineStart;
  if (/^\p{Lu}$/u.test(token) || /^\p{L}$/u.test(token)) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}
