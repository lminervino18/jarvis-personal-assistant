import { WhatsAppStore } from "../integrations/whatsapp/message-store.js";
import { ok } from "./envelope.js";
import { defineTool } from "./types.js";

export const integrationsStatus = defineTool({
  name: "integrations_status",
  description:
    "Informa qué integraciones están conectadas (Gmail por cuenta, WhatsApp, notificaciones, voz, YouTube) y desde qué fecha hay datos sincronizados. Si el puente generó un QR de WhatsApp, lo muestra.",
  async execute(ctx) {
    const groups = await Promise.all(ctx.services.statusSources.map((source) => source.status()));
    for (const source of ctx.services.statusSources) {
      const card = source.pairingCard?.();
      if (card) ctx.emitCard(card);
    }
    return ok({ provider: "integrations" }, groups.flat());
  },
});

export const whatsappLinkQr = defineTool({
  name: "whatsapp_link_qr",
  description:
    "Solo cuando el dueño pide el QR para vincular WhatsApp: le pide al puente que genere uno. A los pocos segundos llamá integrations_status, que lo muestra en una tarjeta. Nunca la uses por iniciativa propia.",
  async execute(ctx) {
    new WhatsAppStore(ctx.services.db).requestWake(ctx.now(), "qr");
    return ok({ provider: "whatsapp" }, [{ requested: true }]);
  },
});
