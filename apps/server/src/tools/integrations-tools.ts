import { ok } from "./envelope.js";
import { defineTool } from "./types.js";

export const integrationsStatus = defineTool({
  name: "integrations_status",
  description:
    "Informa qué integraciones están conectadas (Gmail por cuenta, WhatsApp, notificaciones, voz, YouTube) y desde qué fecha hay datos sincronizados.",
  async execute(ctx) {
    const groups = await Promise.all(ctx.services.statusSources.map((source) => source.status()));
    for (const source of ctx.services.statusSources) {
      const card = source.pairingCard?.();
      if (card) ctx.emitCard(card);
    }
    return ok({ provider: "integrations" }, groups.flat());
  },
});
