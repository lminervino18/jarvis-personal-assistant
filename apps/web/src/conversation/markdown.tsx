import { Fragment, type ReactNode } from "react";
import { safeHref } from "../format.js";

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Splits assistant text into Markdown blocks: paragraphs, headings, lists, quotes, code and tables. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index] as string)) code.push(lines[index++] as string);
      index++;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: (heading[1] as string).length, text: heading[2] as string });
      index++;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      const header = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index] as string)) rows.push(cells(lines[index++] as string));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] as string;
        const match = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (match) {
          items.push((ordered ? match[2] : match[1]) as string);
        } else if (current.trim() && /^\s{2,}/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`;
        } else {
          break;
        }
        index++;
      }
      blocks.push({ kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] as string)) quoted.push((QUOTE.exec(lines[index++] as string) as RegExpExecArray)[1] as string);
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] as string;
      if (!current.trim() || FENCE.test(current) || HEADING.test(current) || BULLET.test(current) || NUMBERED.test(current) || QUOTE.test(current)) break;
      if (TABLE_ROW.test(current) && TABLE_RULE.test(lines[index + 1] ?? "")) break;
      paragraph.push(current);
      index++;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

const INLINE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![\p{L}\p{N}])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}])|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"»])/gu;

function link(href: string, children: ReactNode, key: number): ReactNode {
  const safe = safeHref(href);
  if (!safe) return <Fragment key={key}>{children}</Fragment>;
  return (
    <a key={key} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Bold, italics, strikethrough, inline code and links inside one line, as React elements (never HTML). */
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const [, code, bold, boldUnderscore, strike, italic, italicUnderscore, label, href, url] = match;
    if (code !== undefined) nodes.push(<code key={key++}>{code}</code>);
    else if (bold !== undefined || boldUnderscore !== undefined) nodes.push(<strong key={key++}>{renderInline((bold ?? boldUnderscore) as string)}</strong>);
    else if (strike !== undefined) nodes.push(<s key={key++}>{renderInline(strike)}</s>);
    else if (italic !== undefined || italicUnderscore !== undefined) nodes.push(<em key={key++}>{renderInline((italic ?? italicUnderscore) as string)}</em>);
    else if (label !== undefined && href !== undefined) nodes.push(link(href, renderInline(label), key++));
    else if (url !== undefined) nodes.push(link(url, url, key++));
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function lines(texts: string[]): ReactNode[] {
  return texts.flatMap((line, index) => (index ? [<br key={`br${index}`} />, ...renderInline(line)] : renderInline(line)));
}

/** Assistant text with its Markdown shown as formatting; `tail` (the typing cursor) goes at the end of the last block. */
export function Markdown({ text, tail }: { text: string; tail?: ReactNode }) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, index) => {
        const end = index === blocks.length - 1 ? tail : null;
        switch (block.kind) {
          case "paragraph":
            return (
              <p key={index}>
                {lines(block.lines)}
                {end}
              </p>
            );
          case "heading":
            return (
              <p key={index} className={`md-heading md-h${Math.min(block.level, 3)}`} role="heading" aria-level={Math.min(block.level + 2, 6)}>
                {renderInline(block.text)}
                {end}
              </p>
            );
          case "list": {
            const items = block.items.map((item, at) => (
              <li key={at}>
                {renderInline(item)}
                {at === block.items.length - 1 ? end : null}
              </li>
            ));
            return block.ordered ? (
              <ol key={index} start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={index}>{items}</ul>
            );
          }
          case "quote":
            return (
              <blockquote key={index}>
                {lines(block.lines)}
                {end}
              </blockquote>
            );
          case "code":
            return (
              <pre key={index}>
                <code>{block.text}</code>
                {end}
              </pre>
            );
          case "table":
            return (
              <div key={index} className="table-scroll">
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, at) => (
                        <th key={at}>{renderInline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, at) => (
                      <tr key={at}>
                        {row.map((cell, column) => (
                          <td key={column}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {end}
              </div>
            );
        }
      })}
    </>
  );
}
