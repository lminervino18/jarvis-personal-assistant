import { WhatsAppQueryError, WhatsAppReader } from "../integrations/whatsapp/message-reader.js";
import { OWN_CHAT } from "../integrations/whatsapp/outbox.js";
import { bridgeConnected } from "../integrations/whatsapp/status.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";

const SOURCE = { provider: "images" };
const QUALITY_NAMES = { low: "baja", medium: "media", high: "alta" } as const;

function recipient(ctx: ToolContext, to: string): { jid: string; name: string } {
  if (to === OWN_CHAT) return { jid: OWN_CHAT, name: "vos" };
  const chat = new WhatsAppReader(ctx.services.db, ctx.services.timezone).resolveChat(to, { liveOnly: true });
  return { jid: chat.jid, name: chat.name?.trim() || chat.jid };
}

export const imageCreate = defineTool({
  name: "image_create",
  description:
    "Genera una imagen con OpenAI en segundo plano y la deja en el chat. Para editar o crear a partir de fotos del dueño, pasá sus id en attachmentIds (hasta 4). Calidad media por defecto (unos 5 centavos de dólar); alta solo si el dueño la pide. format: square, portrait (vertical) o landscape. Si el dueño ya dijo a quién mandarla por WhatsApp, pasalo en sendTo (o «me» para su propio chat): se manda sola apenas está lista. Escribí el prompt en detalle, en el idioma que mejor describa la imagen.",
  prepare(ctx, input) {
    if (!ctx.services.images) return { refused: fail("disabled", "La generación de imágenes no está configurada en el servidor (falta la clave de OpenAI).") };
    for (const id of input.attachmentIds ?? []) {
      const attachment = ctx.services.attachments?.get(id);
      if (!attachment?.mediaType.startsWith("image/")) return { refused: fail("invalid_input", "Las referencias tienen que ser fotos que mandó el dueño.") };
    }
    if (!input.sendTo) return { input };
    if (!bridgeConnected(ctx.services.db, ctx.now())) return { refused: fail("not_connected", "WhatsApp no está conectado ahora: no puedo mandarla.") };
    try {
      return { input: { ...input, sendTo: { ...input.sendTo, to: recipient(ctx, input.sendTo.to).jid } } };
    } catch (error) {
      const message = error instanceof WhatsAppQueryError ? error.message : "No encontré ese chat de WhatsApp.";
      return { refused: fail("not_found", message) };
    }
  },
  describe(ctx, input) {
    return {
      title: "Crear imagen",
      summary: input.prompt.slice(0, 120),
      details: [
        { label: "Calidad", value: QUALITY_NAMES[input.quality ?? "medium"] },
        ...(input.sendTo ? [{ label: "Para", value: recipient(ctx, input.sendTo.to).name }] : []),
      ],
    };
  },
  async execute(ctx, input) {
    const images = ctx.services.images;
    if (!images) return fail("disabled", "La generación de imágenes no está configurada en el servidor.");
    const sendTo = input.sendTo ? { ...recipient(ctx, input.sendTo.to), ...(input.sendTo.text ? { text: input.sendTo.text } : {}) } : undefined;
    images.start({ prompt: input.prompt, referenceIds: input.attachmentIds ?? [], quality: input.quality ?? "medium", format: input.format ?? "square", ...(sendTo ? { sendTo } : {}) });
    return ok(SOURCE, [{ status: "generating", quality: input.quality ?? "medium", ...(sendTo ? { sendTo: sendTo.name } : {}) }], {
      note: "Se genera en segundo plano (10 a 60 segundos) y aparece en el chat. No digas que ya está ni que la mandaste.",
    });
  },
});

export const imageTools = [imageCreate] as const;
