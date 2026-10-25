import type { Card } from "@jarvis/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardActions } from "./actions.js";
import { CardView } from "./Cards.js";

const actions: CardActions = {
  decide: () => {},
  registerPlayer: () => () => {},
  reportPlayer: () => {},
  enablePush: async () => ({ ok: true }),
};

const render = (card: Card) => renderToStaticMarkup(<CardView card={card} actions={actions} />);

const future = new Date(Date.now() + 3_600_000).toISOString();
const past = new Date(Date.now() - 3_600_000).toISOString();

const confirm = (status: "pending" | "confirmed", expiresAt = future): Card => ({
  kind: "confirm",
  actionId: "a1",
  title: "Enviar el correo",
  summary: "Se enviará a Ana.",
  details: [{ label: "Para", value: "ana@example.com" }],
  expiresAt,
  status,
});

describe("cards", () => {
  it("offers Confirmar and Rechazar only while a confirmation is pending and valid", () => {
    expect(render(confirm("pending"))).toContain("Confirmar");
    expect(render(confirm("pending"))).toContain("Rechazar");
    expect(render(confirm("confirmed"))).not.toContain("Rechazar");
    expect(render(confirm("pending", past))).not.toContain("Rechazar");
    expect(render(confirm("pending", past))).toContain("Venció");
  });

  it("shows reminder and event times in the card's zone", () => {
    const reminder = render({ kind: "reminder", reminderId: "r", text: "Llamar al médico", dueAt: "2026-10-24T17:30:00.000Z", timezone: "America/Argentina/Buenos_Aires", status: "scheduled" });
    expect(reminder).toContain("Llamar al médico");
    expect(reminder).toContain("14:30");
    expect(reminder).toContain("Programado");
    const event = render({ kind: "event", eventId: "e", title: "Reunión", start: "2026-10-24T17:30:00.000Z", end: "2026-10-24T18:30:00.000Z", timezone: "America/Argentina/Buenos_Aires", location: "Oficina" });
    expect(event).toContain("Reunión");
    expect(event).toContain("Oficina");
  });

  it("renders sources as safe external links and drops unsafe urls", () => {
    const html = render({ kind: "sources", items: [{ title: "Nota", url: "https://example.com/n", source: "Ejemplo" }, { title: "Rara", url: "https://example.com/x", source: "Ejemplo" }] });
    expect(html).toContain('href="https://example.com/n"');
    expect(html).toContain('rel="noopener noreferrer"');
    const unsafe = render({ kind: "integration", provider: "gmail", status: "needs_action", message: "Reconectá Gmail", actionUrl: "javascript:alert(1)", actionLabel: "Reconectar" });
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).toContain("Gmail");
  });

  it("renders an integration action for same-site paths", () => {
    const html = render({ kind: "integration", provider: "reminders", status: "connected", message: "Todo en orden", actionUrl: "/api/x", actionLabel: "Ver" });
    expect(html).toContain('href="/api/x"');
    expect(html).toContain("Recordatorios");
  });

  it("renders the pairing code and a QR only when it is an image", () => {
    const html = render({ kind: "pairing", provider: "whatsapp", code: "ABCD-1234", qr: "raw-qr-payload", expiresAt: future });
    expect(html).toContain("ABCD-1234");
    expect(html).not.toContain("<img");
    const withImage = render({ kind: "pairing", provider: "whatsapp", qr: "data:image/png;base64,AAAA", expiresAt: future });
    expect(withImage).toContain("<img");
  });

  it("renders the notification card with its button and a link card", () => {
    expect(render({ kind: "push_permission", reason: "Para avisarte de recordatorios" })).toContain("Activar notificaciones");
    expect(render({ kind: "link", url: "https://example.com", title: "Sitio", description: "Descripción" })).toContain("Sitio");
  });

  it("starts the YouTube card as loading and never as playing", () => {
    const html = render({ kind: "youtube", requestId: "q", videoId: "dQw4w9WgXcQ", title: "Canción", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", autoplay: true });
    expect(html).toContain("Cargando el reproductor");
    expect(html).not.toContain("Reproduciendo");
    expect(html).toContain("Abrir en YouTube");
  });
});
