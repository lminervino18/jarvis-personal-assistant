import { createRequire } from "node:module";
import type { PdfBlock } from "@jarvis/contracts";
import pdfmake, { type Content, type DocumentDefinition, type FontFamilies } from "pdfmake";
import { chartSvg } from "./charts.js";

const require = createRequire(import.meta.url);
const font = (family: string, file: string) => require.resolve(`@fontsource/${family}/files/${file}`);

const FONTS: FontFamilies = {
  Inter: {
    normal: font("inter", "inter-latin-400-normal.woff"),
    bold: font("inter", "inter-latin-600-normal.woff"),
    italics: font("inter", "inter-latin-400-normal.woff"),
    bolditalics: font("inter", "inter-latin-600-normal.woff"),
  },
  Display: {
    normal: font("space-grotesk", "space-grotesk-latin-500-normal.woff"),
    bold: font("space-grotesk", "space-grotesk-latin-700-normal.woff"),
    italics: font("space-grotesk", "space-grotesk-latin-500-normal.woff"),
    bolditalics: font("space-grotesk", "space-grotesk-latin-700-normal.woff"),
  },
};
const FONT_FILES = new Set(Object.values(FONTS).flatMap((family) => Object.values(family)));

pdfmake.setFonts(FONTS);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => FONT_FILES.has(path));

const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";
const ACCENT = "#0891b2";
const CONTENT_WIDTH = 499;

/** An image the PDF can embed (JPEG or PNG), as a data URL. */
export interface PdfImage {
  dataUrl: string;
}

export interface PdfInput {
  title: string;
  subtitle?: string;
  blocks: PdfBlock[];
  /** Who Jarvis works for, for the signature at the end. */
  ownerName: string;
  /** The date written under the title, already formatted for the owner. */
  date: string;
  images: ReadonlyMap<string, PdfImage>;
}

/** JARVIS's core, small and in the document's accent, for the signature. */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
<circle cx="20" cy="20" r="18.5" fill="none" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="1.6 1.6" opacity="0.6"/>
<circle cx="20" cy="20" r="15.5" fill="none" stroke="${ACCENT}" stroke-width="0.6" opacity="0.5"/>
<path d="M20 6.5A13.5 13.5 0 0 1 32.4 14.6" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>
<path d="M31.2 28.1A13.5 13.5 0 0 1 17.1 33.2" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>
<path d="M8.6 26.6A13.5 13.5 0 0 1 9.3 11.8" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>
<circle cx="20" cy="20" r="8" fill="none" stroke="${ACCENT}" stroke-width="2.4" stroke-dasharray="3.2 1.4"/>
<circle cx="20" cy="20" r="4.4" fill="${ACCENT}"/>
<circle cx="20" cy="20" r="2" fill="#ffffff"/>
</svg>`;

function rule(margin: [number, number, number, number] = [0, 12, 0, 12]): Content {
  return { canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.8, lineColor: LINE }], margin };
}

function table(block: Extract<PdfBlock, { type: "table" }>): Content {
  const columns = block.columns.length;
  const cell = (text: string) => ({ text, fontSize: 9.5 });
  const rows = block.rows.map((row) => Array.from({ length: columns }, (_, index) => cell(row[index] ?? "")));
  return {
    stack: [
      {
        table: {
          headerRows: 1,
          widths: Array.from({ length: columns }, () => "*"),
          body: [block.columns.map((column) => ({ text: column, bold: true, fontSize: 9.5, color: INK, fillColor: "#f1f5f9" })), ...rows],
        },
        layout: {
          hLineWidth: (index: number) => (index === 1 ? 1 : 0.5),
          vLineWidth: () => 0,
          hLineColor: () => LINE,
          fillColor: (row: number) => (row > 0 && row % 2 === 0 ? "#f8fafc" : null),
          paddingTop: () => 6,
          paddingBottom: () => 6,
          paddingLeft: () => 6,
          paddingRight: () => 6,
        },
      },
      ...(block.caption ? [{ text: block.caption, fontSize: 8.5, color: MUTED, margin: [0, 4, 0, 0] as [number, number, number, number] }] : []),
    ],
    margin: [0, 4, 0, 14],
  };
}

function blockContent(block: PdfBlock, images: PdfInput["images"]): Content {
  switch (block.type) {
    case "heading":
      return { text: block.text, font: "Display", bold: true, fontSize: 15, color: INK, margin: [0, 14, 0, 6], headlineLevel: 1 };
    case "text":
      return { text: block.text, margin: [0, 0, 0, 10], lineHeight: 1.35 };
    case "list":
      return { [block.ordered ? "ol" : "ul"]: block.items, margin: [0, 0, 0, 10], lineHeight: 1.3, markerColor: ACCENT } as Content;
    case "table":
      return table(block);
    case "chart":
      return {
        stack: [...(block.title ? [{ text: block.title, bold: true, fontSize: 10.5, margin: [0, 0, 0, 6] as [number, number, number, number] }] : []), { svg: chartSvg(block), width: CONTENT_WIDTH }],
        margin: [0, 6, 0, 14],
        unbreakable: true,
      };
    case "image": {
      const image = images.get(block.attachmentId);
      if (!image) return { text: "", margin: [0, 0, 0, 0] };
      return {
        stack: [{ image: image.dataUrl, fit: [CONTENT_WIDTH, 340], alignment: "center" }, ...(block.caption ? [{ text: block.caption, fontSize: 8.5, color: MUTED, alignment: "center" as const, margin: [0, 4, 0, 0] as [number, number, number, number] }] : [])],
        margin: [0, 6, 0, 14],
        unbreakable: true,
      };
    }
    case "note":
      return {
        table: { widths: [3, "*"], body: [[{ text: "", fillColor: ACCENT }, { text: block.text, fillColor: "#ecfeff", margin: [8, 6, 8, 6], lineHeight: 1.3 }]] },
        layout: "noBorders",
        margin: [0, 2, 0, 12],
      };
    case "link":
      return { text: block.text, link: block.url, color: ACCENT, decoration: "underline", margin: [0, 0, 0, 6] };
    case "pagebreak":
      return { text: "", pageBreak: "after" };
  }
}

/** The document: a white, simple page with the content in order and Jarvis's signature at the end. */
export function pdfDefinition(input: PdfInput): DocumentDefinition {
  return {
    pageSize: "A4",
    pageMargins: [48, 52, 48, 60],
    info: { title: input.title, author: "Jarvis", creator: "J.A.R.V.I.S" },
    defaultStyle: { font: "Inter", fontSize: 10.5, color: INK },
    pageBreakBefore: (current, following) => current.headlineLevel === 1 && following.length === 0,
    footer: (page, pages) => ({
      columns: [
        { text: "J.A.R.V.I.S", font: "Display", fontSize: 7.5, color: MUTED, characterSpacing: 1.5 },
        { text: `${page} / ${pages}`, alignment: "right", fontSize: 7.5, color: MUTED },
      ],
      margin: [48, 24, 48, 0],
    }),
    content: [
      { text: "J.A.R.V.I.S", font: "Display", fontSize: 8, color: ACCENT, characterSpacing: 2.5, margin: [0, 0, 0, 10] },
      { text: input.title, font: "Display", bold: true, fontSize: 26, lineHeight: 1.05, color: INK },
      ...(input.subtitle ? [{ text: input.subtitle, fontSize: 12, color: MUTED, margin: [0, 6, 0, 0] as [number, number, number, number] }] : []),
      { text: input.date, fontSize: 8.5, color: MUTED, margin: [0, 8, 0, 0] },
      rule([0, 14, 0, 16]),
      ...input.blocks.map((block) => blockContent(block, input.images)),
      {
        stack: [
          rule([0, 18, 0, 14]),
          {
            columns: [
              { svg: LOGO, width: 30 },
              {
                stack: [
                  { text: `Hecho por Jarvis, el asistente de ${input.ownerName}`, font: "Display", fontSize: 10, color: INK },
                  { text: input.date, fontSize: 8, color: MUTED, margin: [0, 2, 0, 0] },
                ],
                margin: [10, 4, 0, 0],
              },
            ],
          },
        ],
        unbreakable: true,
      },
    ],
  };
}

/** Renders the document to PDF bytes. */
export async function renderPdf(input: PdfInput): Promise<Buffer> {
  return Buffer.from(await pdfmake.createPdf(pdfDefinition(input)).getBuffer());
}

/** How many pages a rendered PDF has. */
export function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
