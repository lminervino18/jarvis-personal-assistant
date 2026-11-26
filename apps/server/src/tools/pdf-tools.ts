import { safeFileName } from "../tasks/workspace.js";
import { pageCount, renderPdf, type PdfImage } from "../pdfs/pdf-document.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const SOURCE = { provider: "pdf" };
const EMBEDDABLE = new Set(["image/jpeg", "image/png"]);

export const pdfCreate = defineTool({
  name: "pdf_create",
  description:
    "Arma un PDF blanco y simple con lo que pida el dueño, en bloques y en orden: heading, text, list, table (columnas y filas), chart (bar, line o pie con labels y series), image (una foto del chat, JPEG o PNG, por attachmentId), note (un recuadro para lo más importante), link y pagebreak. Al final lleva el logo de Jarvis y «Hecho por Jarvis, el asistente de <dueño>». Escribí todo el contenido vos, prolijo y en rioplatense, con datos confirmados: si salen de WebSearch, poné la fecha de la búsqueda y las fuentes como links. Queda como archivo en el chat; para mandarlo usá whatsapp_send o gmail_send con su attachmentId.",
  prepare(ctx, input) {
    if (!ctx.services.attachments) return { refused: fail("disabled", "Los archivos del chat no están configurados en el servidor.") };
    for (const block of input.blocks) {
      if (block.type !== "image") continue;
      const attachment = ctx.services.attachments.get(block.attachmentId);
      if (!attachment) return { refused: fail("not_found", "Una de las fotos ya no está en el chat.") };
      if (!EMBEDDABLE.has(attachment.mediaType)) return { refused: fail("invalid_input", `«${attachment.name}» no es JPEG ni PNG: el PDF no puede llevarla.`) };
    }
    return { input };
  },
  async execute(ctx, input) {
    const attachments = ctx.services.attachments;
    if (!attachments) return fail("disabled", "Los archivos del chat no están configurados en el servidor.");
    const images = new Map<string, PdfImage>();
    for (const block of input.blocks) {
      if (block.type !== "image" || images.has(block.attachmentId)) continue;
      const stored = attachments.read(block.attachmentId);
      if (stored) images.set(block.attachmentId, { dataUrl: `data:${stored.attachment.mediaType};base64,${stored.data.toString("base64")}` });
    }
    const date = new Intl.DateTimeFormat("es-AR", { dateStyle: "long", timeZone: ctx.services.timezone }).format(ctx.now());
    const pdf = await renderPdf({
      title: input.title,
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
      blocks: input.blocks,
      ownerName: ctx.services.ownerName ?? "su dueño",
      date,
      images,
    });
    const saved = attachments.save({ name: safeFileName(`${input.fileName ?? input.title}.pdf`), mediaType: "application/pdf", data: pdf }, ctx.now());
    if (!saved) return fail("invalid_input", "El PDF quedó demasiado pesado. Sacale fotos o achicá tablas.");
    ctx.emitCard(attachments.card(saved));
    return ok(SOURCE, [{ attachmentId: saved.id, name: saved.name, pages: pageCount(pdf), size: saved.size }], {
      note: "El PDF ya está en el chat. Para mandarlo a alguien usá whatsapp_send o gmail_send con este attachmentId.",
    });
  },
});

export const pdfTools = [pdfCreate] as const;
