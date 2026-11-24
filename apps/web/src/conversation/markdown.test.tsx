import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, parseBlocks } from "./markdown.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("assistant markdown", () => {
  it("shows bold, italics, code and strikethrough instead of the symbols", () => {
    expect(html("Te dejo **dos opciones**, *rápido* y `npm test`, ~~no~~.")).toBe(
      "<p>Te dejo <strong>dos opciones</strong>, <em>rápido</em> y <code>npm test</code>, <s>no</s>.</p>",
    );
    expect(html("**Hoy:** a las *9*")).toBe("<p><strong>Hoy:</strong> a las <em>9</em></p>");
  });

  it("leaves words with underscores, lone asterisks and unfinished marks as they are", () => {
    expect(html("usá chat_id y 5 * 3 * 2")).toBe("<p>usá chat_id y 5 * 3 * 2</p>");
    expect(html("**escribiendo")).toBe("<p>**escribiendo</p>");
  });

  it("builds lists, headings, quotes and code blocks", () => {
    expect(html("## Agenda\n- uno\n- **dos**\n  sigue\n\n1. primero\n2. segundo")).toBe(
      '<p class="md-heading md-h2" role="heading" aria-level="4">Agenda</p><ul><li>uno</li><li><strong>dos</strong> sigue</li></ul><ol start="1"><li>primero</li><li>segundo</li></ol>',
    );
    expect(html("> dijo esto\n\n```\nconst a = 1;\n```")).toBe("<blockquote>dijo esto</blockquote><pre><code>const a = 1;</code></pre>");
    expect(html("una\ndos")).toBe("<p>una<br/>dos</p>");
  });

  it("makes tables and safe links, and never links other schemes", () => {
    expect(parseBlocks("| A | B |\n|---|---|\n| 1 | 2 |")).toEqual([{ kind: "table", header: ["A", "B"], rows: [["1", "2"]] }]);
    expect(html("[la página](https://p.example.test/x) y https://example.test/a.")).toBe(
      '<p><a href="https://p.example.test/x" target="_blank" rel="noopener noreferrer">la página</a> y <a href="https://example.test/a" target="_blank" rel="noopener noreferrer">https://example.test/a</a>.</p>',
    );
    expect(html("[clic](javascript:alert)")).toBe("<p>clic</p>");
    expect(html("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });
});
