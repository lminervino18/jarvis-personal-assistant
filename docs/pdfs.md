# PDFs

Jarvis makes PDFs with `pdf_create` (`apps/server/src/tools/pdf-tools.ts`). The model writes the content as ordered blocks (`PdfBlock` in `packages/contracts`):
- `heading`, `text`, `list` (ordered or not);
- `table` (up to 8 columns and 100 rows);
- `chart` (`bar`, `line` or `pie`, with labels, up to 5 series and an optional unit);
- `image` (a JPEG or PNG chat attachment);
- `note` (a highlighted box);
- `link` (http or https only);
- `pagebreak`.

**Look:**
- An A4 page, white and simple: Space Grotesk for titles, Inter for text, one cyan accent, a header with «J.A.R.V.I.S», the title, an optional subtitle and the date.
- Every page has its number at the bottom.
- The end carries the core logo and «Hecho por Jarvis, el asistente de {OWNER_DISPLAY_NAME}».

**Rendering:**
- [pdfmake](https://github.com/bpampuch/pdfmake) 0.3, pure JavaScript on the server, with no browser. Charts are SVG drawn by `pdfs/charts.ts`. Bars start at zero; lines fit their values in four round steps.
- Fonts come from `@fontsource` as WOFF: fontkit fails to subset the WOFF2 files.
- pdfmake may not fetch URLs and reads only those font files (`setUrlAccessPolicy`, `setLocalAccessPolicy`).
- Its own types (`@types/pdfmake`) pull DOM globals into the whole server, so `pdfs/pdfmake.d.ts` declares only what is used.

**The result:** a chat attachment (`application/pdf`), shown as a card. To send it, the model uses `whatsapp_send` or `gmail_send` with its id. Creating a PDF changes nothing outside, so it runs even after a web search; sending still needs the owner's OK in that case.
