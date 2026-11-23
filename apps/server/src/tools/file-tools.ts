import { LINK_DAYS } from "../files/file-links.js";
import { fail, ok } from "./envelope.js";
import { defineTool } from "./types.js";

const WHATSAPP = { provider: "whatsapp" };
const FILES = { provider: "files" };

const FETCH_FAILURES = {
  not_media: "Ese mensaje no tiene un archivo que se pueda bajar (o llegó antes de que JARVIS guardara archivos).",
  too_large: "El archivo pesa más de 64 MB; no lo bajo.",
  expired: "WhatsApp ya no tiene ese archivo en sus servidores (pasó demasiado tiempo). Pedile al dueño que lo reenvíe.",
  failed: "No pude bajar el archivo de WhatsApp; probá de nuevo en un rato.",
} as const;

export const whatsappGetFile = defineTool({
  name: "whatsapp_get_file",
  description:
    "Baja el archivo de un mensaje de WhatsApp (foto, audio, video, PDF, Excel, CSV, Word o cualquier documento) usando el chatId y messageId que muestran whatsapp_get_messages o whatsapp_search en 'file'. Devuelve un attachmentId para reenviarlo (whatsapp_send, whatsapp_to_me, gmail_send), compartirlo (file_share_link) o ponerlo en una página (page_create), y lo que tiene adentro: las fotos y cuadros de video para que los mires, la transcripción de audios y videos, y el texto de PDF, Word, Excel y CSV.",
  async execute(ctx, input) {
    const files = ctx.services.whatsappFiles;
    const attachments = ctx.services.attachments;
    if (!files || !attachments) return fail("disabled", "Los archivos de WhatsApp no están configurados en el servidor.");
    const fetched = await files.fetch(input.chatId, input.messageId, ctx.now());
    if (!fetched.ok) return fail(fetched.reason === "not_media" ? "not_found" : "upstream_error", FETCH_FAILURES[fetched.reason], fetched.reason === "failed");
    const stored = attachments.read(fetched.attachment.id);
    if (!stored) return fail("internal", "El archivo se bajó pero no lo encuentro guardado.");
    const analysis = ctx.services.analyzeFile ? await ctx.services.analyzeFile({ name: stored.attachment.name, mediaType: stored.attachment.mediaType, data: stored.data }) : { images: [] };
    const { attachment, file } = fetched;
    return ok(WHATSAPP, [
      {
        attachmentId: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        kind: file.kind,
        ...(file.seconds !== null ? { seconds: file.seconds } : {}),
        ...(file.voiceNote ? { voiceNote: true } : {}),
        ...(analysis.text ? { content: analysis.text } : {}),
        ...(analysis.note ? { note: analysis.note } : {}),
        ...(analysis.images.length ? { images: analysis.images } : {}),
      },
    ]);
  },
});

export const fileShareLink = defineTool({
  name: "file_share_link",
  description: `Crea un link público, imposible de adivinar, para ver o bajar un archivo (attachmentId) en su calidad original, sin cuenta. Vence a los ${LINK_DAYS} días. Usalo cuando el dueño quiere pasarle un archivo a alguien o subirlo a un link.`,
  describe(ctx, input) {
    const attachment = ctx.services.attachments?.get(input.attachmentId);
    return {
      title: "Compartir archivo",
      summary: attachment?.name ?? "Archivo",
      details: [{ label: "Link", value: `Público para quien lo tenga, vence en ${LINK_DAYS} días` }],
    };
  },
  async execute(ctx, input) {
    const { attachments, fileLinks, filesBaseUrl } = ctx.services;
    if (!attachments || !fileLinks || !filesBaseUrl) return fail("disabled", "Los links de archivos no están configurados en el servidor.");
    const attachment = attachments.get(input.attachmentId);
    if (!attachment) return fail("not_found", "Ese archivo no existe.");
    const link = fileLinks.create(attachment.id, ctx.now());
    return ok(FILES, [{ url: `${filesBaseUrl.replace(/\/+$/, "")}/d/${link.token}`, name: attachment.name, expiresAt: link.expiresAt }]);
  },
});

export const fileTools = [whatsappGetFile, fileShareLink];
