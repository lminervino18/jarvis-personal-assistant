/** The slice of pdfmake 0.3 the server uses; its own types pull DOM globals into the whole project. */
declare module "pdfmake" {
  type Margins = [number, number, number, number];

  export interface TableLayout {
    hLineWidth?(index: number): number;
    vLineWidth?(index: number): number;
    hLineColor?(index: number): string;
    fillColor?(row: number): string | null;
    paddingTop?(index: number): number;
    paddingBottom?(index: number): number;
    paddingLeft?(index: number): number;
    paddingRight?(index: number): number;
  }

  export type Content =
    | string
    | Content[]
    | {
        text?: string | Content[];
        stack?: Content[];
        columns?: Content[];
        ul?: string[];
        ol?: string[];
        table?: { headerRows?: number; widths: (number | string)[]; body: Content[][] };
        layout?: TableLayout | "noBorders";
        canvas?: { type: "line"; x1: number; y1: number; x2: number; y2: number; lineWidth: number; lineColor: string }[];
        svg?: string;
        image?: string;
        fit?: [number, number];
        width?: number;
        font?: string;
        fontSize?: number;
        bold?: boolean;
        color?: string;
        fillColor?: string | null;
        characterSpacing?: number;
        lineHeight?: number;
        alignment?: "left" | "center" | "right";
        decoration?: "underline";
        link?: string;
        markerColor?: string;
        margin?: Margins;
        unbreakable?: boolean;
        pageBreak?: "after" | "before";
        headlineLevel?: number;
      };

  export interface DocumentDefinition {
    pageSize: string;
    pageMargins: Margins;
    info?: { title?: string; author?: string; creator?: string };
    defaultStyle?: { font?: string; fontSize?: number; color?: string };
    footer?(page: number, pages: number): Content;
    pageBreakBefore?(current: { headlineLevel?: number }, following: unknown[]): boolean;
    content: Content[];
  }

  export type FontFamilies = Record<string, { normal: string; bold: string; italics: string; bolditalics: string }>;

  interface PdfMake {
    setFonts(fonts: FontFamilies): void;
    setUrlAccessPolicy(allow: (url: string) => boolean): void;
    setLocalAccessPolicy(allow: (path: string) => boolean): void;
    createPdf(definition: DocumentDefinition): { getBuffer(): Promise<Uint8Array> };
  }

  const pdfmake: PdfMake;
  export default pdfmake;
}
