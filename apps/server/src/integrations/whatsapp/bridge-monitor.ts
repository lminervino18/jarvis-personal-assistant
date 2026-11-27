import type { Db } from "../../db/database.js";
import { Outbox } from "../../worker/outbox.js";
import { NOTIFICATION_TITLE } from "../../push/notification.js";

const STALE_MS = 3 * 60_000;
/** A connection that comes back alone within this long is not worth a notice. */
const OFFLINE_NOTICE_MS = 15 * 60_000;
/** At most one notice in this long, even across server restarts. */
const NOTICE_WINDOW_MS = 6 * 3_600_000;

interface BridgeRow {
  status: string;
  last_event_at: string | null;
  detail: string | null;
}

/**
 * Notices when the live WhatsApp bridge falls and tells the owner once, by push and in the chat:
 * at once when only the owner can bring it back (a new QR scan, a refused connection), and after
 * a quarter of an hour when it is only offline and keeps trying on its own.
 */
export class BridgeMonitor {
  private downSince?: number;
  private told = false;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  check(): void {
    const row = this.db.prepare("SELECT status, last_event_at, detail FROM wa_sync_state WHERE source = 'baileys'").get() as BridgeRow | undefined;
    const now = this.now().getTime();
    if (!row || row.status === "disabled" || row.status === "pairing" || this.alive(row, now)) {
      this.downSince = undefined;
      this.told = false;
      return;
    }
    this.downSince ??= now;
    if (this.told) return;
    const needsOwner = row.status === "logged_out" || row.status === "error";
    if (!needsOwner && now - this.downSince < OFFLINE_NOTICE_MS) return;
    this.told = true;
    this.tell(needsOwner ? this.ownerNotice(row) : "WhatsApp está sin conexión hace un rato. Sigo intentando solo; si querés probar ya, abrí Configuración.", now);
  }

  private alive(row: BridgeRow, now: number): boolean {
    return row.status === "connected" && row.last_event_at !== null && now - Date.parse(row.last_event_at) <= STALE_MS;
  }

  private ownerNotice(row: BridgeRow): string {
    if (row.status === "logged_out") return "Se desvinculó WhatsApp. Abrí Configuración: ahí te dejo el QR para escanearlo de nuevo.";
    return `Se cayó WhatsApp: ${row.detail ?? "el puente se detuvo."}`;
  }

  private tell(text: string, now: number): void {
    const at = new Date(now);
    const window = Math.floor(now / NOTICE_WINDOW_MS);
    const outbox = new Outbox(this.db);
    outbox.enqueue({ kind: "push", dedupeKey: `whatsapp-down:${window}:push`, payload: { title: NOTIFICATION_TITLE, body: text, tag: "whatsapp-down", url: "/" } }, at);
    outbox.enqueue({ kind: "chat_message", dedupeKey: `whatsapp-down:${window}:chat`, payload: { text, cards: [] } }, at);
  }
}
