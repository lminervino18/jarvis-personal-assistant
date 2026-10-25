import { Browsers, proto, type SocketConfig } from "baileys";
import { isIgnoredJid } from "./message-mapper.js";

export const BRIDGE_BROWSER = Browsers.ubuntu("Chrome");

/**
 * Socket settings chosen to look like one quiet, stable linked device and to ask WhatsApp for as little
 * as possible. Each field is explained in docs/integrations/whatsapp.md (anti-ban measures).
 */
export function conservativeSocketConfig(logger: SocketConfig["logger"]): Partial<SocketConfig> {
  return {
    logger,
    browser: BRIDGE_BROWSER,
    countryCode: "AR",
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) =>
      syncType !== proto.HistorySync.HistorySyncType.FULL && syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND,
    shouldIgnoreJid: (jid) => isIgnoredJid(jid),
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  };
}
