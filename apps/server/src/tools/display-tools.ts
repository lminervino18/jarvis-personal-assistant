import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "display" };

export const showChart = defineTool({
  name: "show_chart",
  description:
    "Muestra un gráfico en el chat con datos que ya tenés (de otras herramientas o del dueño): barras, líneas, área, torta o progreso (valores en %). Cada serie lleva un valor por etiqueta; la torta usa una sola serie. No inventes datos.",
  async execute(ctx, input) {
    const mismatch = input.series.find((series) => series.values.length !== input.labels.length);
    if (mismatch) return fail("invalid_input", `La serie «${mismatch.name}» tiene ${mismatch.values.length} valores y hay ${input.labels.length} etiquetas.`);
    if (input.chart === "pie" && input.series.length > 1) return fail("invalid_input", "Una torta muestra una sola serie.");
    ctx.emitCard({ kind: "chart", ...input });
    return ok(SOURCE, [{ shown: "chart", title: input.title }], { note: "El gráfico ya está en la tarjeta del chat; no repitas los números salvo que te los pidan." });
  },
});

export const showTable = defineTool({
  name: "show_table",
  description: "Muestra una tabla en el chat (hasta 8 columnas y 50 filas, celdas de texto) con datos que ya tenés. Útil para comparar o listar con varios campos.",
  async execute(ctx, input) {
    const wide = input.rows.findIndex((row) => row.length > input.columns.length);
    if (wide >= 0) return fail("invalid_input", `La fila ${wide + 1} tiene más celdas que columnas.`);
    ctx.emitCard({ kind: "table", ...input });
    return ok(SOURCE, [{ shown: "table", title: input.title, rows: input.rows.length }], { note: "La tabla ya está en la tarjeta del chat; resumila en una frase." });
  },
});

export const displayTools = [showChart, showTable];
