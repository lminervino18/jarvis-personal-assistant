import type { Card } from "@jarvis/contracts";
import type { Db } from "../../db/database.js";
import type { IntegrationStatusItem, IntegrationStatusSource } from "../../tools/types.js";
import { toZonedIso } from "../../util/time.js";
import { WhatsAppReader, type SourceCoverage } from "./message-reader.js";
import type { PairingStore } from "./pairing-store.js";

const BRIDGE_STALE_MS = 3 * 60_000;

interface SyncRow {
  status: string;
  last_event_at: string | null;
  detail: string | null;
}

/** Status for the two WhatsApp sources, plus the pairing card while the bridge waits for a QR scan. */
export class WhatsAppStatusSource implements IntegrationStatusSource {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
    private readonly pairing?: Pick<PairingStore, "card">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(): Promise<IntegrationStatusItem[]> {
    const coverage = new WhatsAppReader(this.db, this.timezone).coverage().sources;
    const find = (source: SourceCoverage["source"]) => coverage.find((candidate) => candidate.source === source);
    return [this.bridgeItem(find("baileys")), this.importItem(find("import"))];
  }

  pairingCard(): Card | undefined {
    return this.pairing?.card(this.now());
  }

  private range(source: SourceCoverage | undefined): IntegrationStatusItem["coverage"] {
    if (!source?.earliest || !source.latest) return undefined;
    return { from: toZonedIso(source.earliest, this.timezone), to: toZonedIso(source.latest, this.timezone) };
  }

  private importItem(source: SourceCoverage | undefined): IntegrationStatusItem {
    if (!source || source.messages === 0) {
      return { provider: "whatsapp", account: "import", status: "disconnected", detail: "No hay chats importados." };
    }
    return {
      provider: "whatsapp",
      account: "import",
      status: "connected",
      detail: `Chats importados desde exportaciones: ${source.messages} mensajes.`,
      coverage: this.range(source),
    };
  }

  private bridgeItem(source: SourceCoverage | undefined): IntegrationStatusItem {
    const row = this.db.prepare("SELECT status, last_event_at, detail FROM wa_sync_state WHERE source = 'baileys'").get() as SyncRow | undefined;
    const base = { provider: "whatsapp" as const, account: "baileys", coverage: this.range(source) };
    if (!row || row.status === "disabled") {
      return { ...base, status: "disabled", detail: "Sincronización en vivo desactivada (WHATSAPP_ENABLED). Solo hay chats importados." };
    }
    switch (row.status) {
      case "connected":
        return this.isStale(row) ? { ...base, status: "disconnected", detail: "El puente no da señales de vida." } : { ...base, status: "connected", detail: "Sincronizando en vivo (solo lectura)." };
      case "pairing":
        return { ...base, status: "needs_action", detail: "Esperando que escanees el código QR desde WhatsApp > Dispositivos vinculados." };
      case "logged_out":
        return { ...base, status: "needs_action", detail: row.detail ?? "La sesión se cerró; hay que volver a vincular." };
      case "error":
        return { ...base, status: "error", detail: row.detail ?? "El puente se detuvo por un error." };
      default:
        return { ...base, status: "disconnected", detail: row.detail ?? "Puente desconectado." };
    }
  }

  private isStale(row: SyncRow): boolean {
    return !row.last_event_at || this.now().getTime() - new Date(row.last_event_at).getTime() > BRIDGE_STALE_MS;
  }
}
