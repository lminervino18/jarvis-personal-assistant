import type { Card, TaskCardAction } from "@jarvis/contracts";
import { useState } from "react";
import { formatDateTime, safeHref } from "../format.js";
import type { CardActions } from "./actions.js";
import { QrCode } from "./QrCode.js";
import { YoutubeCard } from "./YoutubeCard.js";
import { ChartCard } from "./ChartCard.js";

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
  agents: "Agentes",
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

const taskStatus: Record<Of<"task">["status"], string> = {
  queued: "En cola",
  running: "Trabajando",
  awaiting_owner: "Te necesita",
  ready: "Lista para revisar",
  accepted: "Aceptada",
  failed: "Falló",
  cancelled: "Cancelada",
};

const taskPhase: Record<NonNullable<Of<"task">["phase"]>, string> = {
  plan: "planificación",
  execute: "ejecución",
  review: "revisión",
};

const blockerLabel: Record<NonNullable<Of<"task">["blocker"]>["kind"], string> = {
  question: "Pregunta",
  approval: "Pide tu aprobación",
  review_limit: "No pasó la revisión",
  budget: "Sin presupuesto",
  usage_limit: "Límite de uso de Claude",
  error: "Error",
};

const publishStep: Record<string, string> = {
  verify: "verificando",
  prepare: "preparando",
  apply: "aplicando el cambio",
  checks: "chequeo completo",
  commit: "creando el commit",
  push: "subiendo a GitHub",
  deploy: "desplegando",
};

function publicationLine(publication: NonNullable<Of<"task">["publication"]>): string {
  switch (publication.status) {
    case "queued":
      return "Publicación en cola";
    case "running":
      return `Publicando${publication.step ? ` · ${publishStep[publication.step] ?? publication.step}` : ""}`;
    case "published":
      return `Publicado en producción${publication.commit ? ` · commit ${publication.commit.slice(0, 7)}` : ""}`;
    case "failed":
      return `No se publicó${publication.message ? `: ${publication.message}` : ""}`;
  }
}

function taskActionsFor(card: Of<"task">): { action: TaskCardAction; label: string; primary?: boolean }[] {
  if (card.status === "ready" && card.build) {
    return [
      { action: "publish", label: "Publicar", primary: true },
      { action: "cancel", label: "Descartar" },
    ];
  }
  if (card.status === "ready") return [{ action: "accept", label: "Aceptar entrega", primary: true }];
  if (card.status === "accepted" || card.status === "failed" || card.status === "cancelled") return [];
  if (card.blocker?.kind === "approval") {
    return [
      { action: "approve", label: "Aprobar", primary: true },
      { action: "reject", label: "Rechazar" },
      { action: "cancel", label: "Cancelar tarea" },
    ];
  }
  if (card.status === "awaiting_owner") {
    const resumable = card.blocker && ["usage_limit", "error", "review_limit"].includes(card.blocker.kind);
    return [...(resumable ? [{ action: "resume" as const, label: "Reintentar" }] : []), { action: "cancel", label: "Cancelar tarea" }];
  }
  return [card.paused ? { action: "resume", label: "Reanudar" } : { action: "pause", label: "Pausar" }, { action: "cancel", label: "Cancelar tarea" }];
}

function TaskCard({ card, actions }: { card: Of<"task">; actions: CardActions }) {
  const [sent, setSent] = useState<string | null>(null);
  const status = card.paused && (card.status === "queued" || card.status === "running") ? "En pausa" : taskStatus[card.status];
  const phase = card.phase && (card.status === "queued" || card.status === "running") ? ` · ${taskPhase[card.phase]}` : "";
  const buttons = taskActionsFor(card);
  const act = (action: TaskCardAction) => {
    setSent(`${card.updatedAt}:${action}`);
    actions.taskAction(card.taskId, action, action === "approve" || action === "reject" ? card.blocker?.approvalId : undefined);
  };
  const pending = sent?.startsWith(`${card.updatedAt}:`);
  return (
    <section className="card card-task" aria-label={`Tarea ${card.ref}: ${card.title}`}>
      <p className="card-kicker">Tarea #{card.ref}</p>
      <h3 className="card-title">{card.title}</h3>
      <p className="card-status" data-status={card.status} role="status">
        {status}
        {phase}
        {card.iteration > 0 ? ` · iteración ${card.iteration}` : ""}
      </p>
      {card.blocker && (
        <div className="card-blocker">
          <p className="card-kicker">{blockerLabel[card.blocker.kind]}</p>
          <p>{card.blocker.message}</p>
        </div>
      )}
      {card.summary && <p>{card.summary}</p>}
      {card.review && (
        <p className="card-meta">
          Revisión independiente: {card.review.passed} de {card.review.total} criterios con evidencia
        </p>
      )}
      {card.deliverables && card.deliverables.length > 0 && (
        <ul className="card-sources">
          {card.deliverables.map((item) => (
            <li key={item.path}>
              <a href={`/api/tasks/${card.ref}/files?path=${encodeURIComponent(item.path)}`} target="_blank" rel="noopener noreferrer">
                {item.path}
              </a>
              <span className="card-meta">{item.description}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="card-meta">
        Consumo del plan ≈ USD {card.costUsd.toFixed(2)} de {card.budgetUsd.toFixed(2)}
        {card.iteration > 0 && (
          <>
            {" · "}
            <a href={`/api/tasks/${card.ref}/diff`} target="_blank" rel="noopener noreferrer">
              ver cambios
            </a>
          </>
        )}
      </p>
      {card.publication && (
        <p className="card-status" data-status={card.publication.status === "failed" ? "failed" : card.publication.status === "published" ? "accepted" : "running"} role="status">
          {publicationLine(card.publication)}
        </p>
      )}
      {card.status === "ready" && (
        <p className="card-meta">
          {card.build ? "Publicar lo chequea entero, lo sube a GitHub y lo despliega. Para pedir cambios, respondé abajo." : "Para pedir cambios, escribilos en el chat."}
        </p>
      )}
      {buttons.length > 0 && !pending && (
        <div className="card-actions">
          {buttons.map((button) => (
            <button key={button.action} type="button" className={button.primary ? "button primary" : "button"} onClick={() => act(button.action)}>
              {button.label}
            </button>
          ))}
        </div>
      )}
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

function TableCard({ card }: { card: Extract<Card, { kind: "table" }> }) {
  return (
    <section className="card card-table" aria-label={`Tabla: ${card.title}`}>
      <p className="card-kicker">Tabla</p>
      <h3 className="card-title">{card.title}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {card.columns.map((column, i) => (
                <th key={i} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row, r) => (
              <tr key={r}>
                {card.columns.map((_, c) => (
                  <td key={c}>{row[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card.note && <p className="card-meta">{card.note}</p>}
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
    case "task":
      return <TaskCard card={card} actions={actions} />;
    case "chart":
      return <ChartCard card={card} />;
    case "table":
      return <TableCard card={card} />;
  }
}
