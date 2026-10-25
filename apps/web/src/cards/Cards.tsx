import type { Card } from "@jarvis/contracts";
import { useState } from "react";
import { formatDateTime, safeHref } from "../format.js";
import type { CardActions } from "./actions.js";
import { QrCode } from "./QrCode.js";
import { YoutubeCard } from "./YoutubeCard.js";

type Of<K extends Card["kind"]> = Extract<Card, { kind: K }>;

const reminderStatus: Record<Of<"reminder">["status"], string> = {
  scheduled: "Programado",
  fired: "Sonó",
  cancelled: "Cancelado",
  missed: "Se pasó",
};

const confirmStatus: Record<Of<"confirm">["status"], string> = {
  pending: "Esperando tu respuesta",
  confirmed: "Confirmado",
  rejected: "Rechazado",
  expired: "Venció",
  failed: "No se pudo completar",
};

const integrationStatus: Record<Of<"integration">["status"], string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  needs_action: "Requiere acción",
  error: "Con problemas",
  disabled: "Desactivado",
};

export const providerNames: Record<Of<"integration">["provider"], string> = {
  claude: "Claude",
  gmail: "Gmail",
  whatsapp: "WhatsApp",
  calendar: "Calendario",
  reminders: "Recordatorios",
  youtube: "YouTube",
  push: "Notificaciones",
  voice: "Voz",
};

function ExternalLink({ href, children }: { href: string | undefined; children: string }) {
  const safe = safeHref(href);
  if (!safe) return null;
  const external = !safe.startsWith("/");
  return (
    <a className="button" href={safe} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

function ConfirmCard({ card, actions }: { card: Of<"confirm">; actions: CardActions }) {
  const [sent, setSent] = useState(false);
  const open = card.status === "pending" && !sent && Date.parse(card.expiresAt) > Date.now();
  const status = card.status === "pending" && Date.parse(card.expiresAt) <= Date.now() ? confirmStatus.expired : confirmStatus[card.status];
  const decide = (decision: "confirm" | "reject") => {
    setSent(true);
    actions.decide(card.actionId, decision);
  };
  return (
    <section className="card card-confirm" aria-label={`Confirmación: ${card.title}`}>
      <h3 className="card-title">{card.title}</h3>
      <p>{card.summary}</p>
      {card.details.length > 0 && (
        <dl className="card-details">
          {card.details.map((detail) => (
            <div key={`${detail.label}:${detail.value}`}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="card-status" data-status={card.status} role="status">
        {sent && card.status === "pending" ? "Enviando tu respuesta" : status}
      </p>
      {open && (
        <div className="card-actions">
          <button type="button" className="button primary" onClick={() => decide("confirm")}>
            Confirmar
          </button>
          <button type="button" className="button" onClick={() => decide("reject")}>
            Rechazar
          </button>
        </div>
      )}
    </section>
  );
}

function ReminderCard({ card }: { card: Of<"reminder"> }) {
  return (
    <section className="card" aria-label="Recordatorio">
      <p className="card-kicker">Recordatorio</p>
      <h3 className="card-title">{card.text}</h3>
      <p className="card-meta">
        {formatDateTime(card.dueAt, card.timezone)} · {reminderStatus[card.status]}
      </p>
    </section>
  );
}

function EventCard({ card }: { card: Of<"event"> }) {
  return (
    <section className="card" aria-label="Evento">
      <p className="card-kicker">Evento</p>
      <h3 className="card-title">{card.title}</h3>
      <p className="card-meta">
        {formatDateTime(card.start, card.timezone)}
        {card.end ? ` – ${formatDateTime(card.end, card.timezone)}` : ""}
      </p>
      {card.location && <p className="card-meta">{card.location}</p>}
    </section>
  );
}

function SourcesCard({ card }: { card: Of<"sources"> }) {
  return (
    <section className="card" aria-label="Fuentes">
      <p className="card-kicker">Fuentes</p>
      <ul className="card-sources">
        {card.items.map((item, index) => {
          const href = safeHref(item.url);
          return (
            <li key={`${item.title}:${index}`}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {item.title}
                </a>
              ) : (
                <span>{item.title}</span>
              )}
              <span className="card-meta">{[item.source, item.date].filter(Boolean).join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function IntegrationCard({ card }: { card: Of<"integration"> }) {
  return (
    <section className="card" aria-label={`Conexión: ${providerNames[card.provider]}`}>
      <p className="card-kicker">{providerNames[card.provider]}</p>
      <p>{card.message}</p>
      <p className="card-status" data-status={card.status}>
        {integrationStatus[card.status]}
        {card.account ? ` · ${card.account}` : ""}
      </p>
      {safeHref(card.actionUrl) && (
        <div className="card-actions">
          <ExternalLink href={card.actionUrl}>{card.actionLabel ?? "Abrir"}</ExternalLink>
        </div>
      )}
    </section>
  );
}

function PairingCard({ card }: { card: Of<"pairing"> }) {
  const expired = Date.parse(card.expiresAt) <= Date.now();
  const image = card.qr?.startsWith("data:image/") ? card.qr : null;
  const label = "Código QR para vincular WhatsApp";
  return (
    <section className="card" aria-label="Vincular WhatsApp">
      <p className="card-kicker">WhatsApp</p>
      <p>Vinculá tu cuenta desde WhatsApp, en Dispositivos vinculados.</p>
      {!expired && image && <img className="card-qr" src={image} alt={label} />}
      {!expired && !image && card.qr && <QrCode value={card.qr} label={label} />}
      {!expired && card.code && (
        <p className="card-code" aria-label="Código de vinculación">
          {card.code}
        </p>
      )}
      <p className="card-status" data-status={expired ? "expired" : "pending"}>
        {expired ? "Venció. Pedí uno nuevo." : `Vence ${formatDateTime(card.expiresAt)}`}
      </p>
    </section>
  );
}

function PushPermissionCard({ card, actions }: { card: Of<"push_permission">; actions: CardActions }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    const result = await actions.enablePush();
    setBusy(false);
    setMessage(result.ok ? "Pedido enviado." : result.message);
  };
  return (
    <section className="card" aria-label="Notificaciones">
      <p className="card-kicker">Notificaciones</p>
      <p>{card.reason}</p>
      {message && (
        <p className="card-status" role="status">
          {message}
        </p>
      )}
      <div className="card-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void enable()}>
          Activar notificaciones
        </button>
      </div>
    </section>
  );
}

function LinkCard({ card }: { card: Of<"link"> }) {
  const href = safeHref(card.url);
  return (
    <section className="card" aria-label="Enlace">
      <h3 className="card-title">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{card.title}</a> : card.title}</h3>
      {card.description && <p className="card-meta">{card.description}</p>}
    </section>
  );
}

export function CardView({ card, actions }: { card: Card; actions: CardActions }) {
  switch (card.kind) {
    case "youtube":
      return <YoutubeCard card={card} actions={actions} />;
    case "confirm":
      return <ConfirmCard card={card} actions={actions} />;
    case "reminder":
      return <ReminderCard card={card} />;
    case "event":
      return <EventCard card={card} />;
    case "sources":
      return <SourcesCard card={card} />;
    case "integration":
      return <IntegrationCard card={card} />;
    case "pairing":
      return <PairingCard card={card} />;
    case "push_permission":
      return <PushPermissionCard card={card} actions={actions} />;
    case "link":
      return <LinkCard card={card} />;
  }
}
