import type { Card } from "@jarvis/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardActions } from "./actions.js";
import { CardView } from "./Cards.js";
import { personPick } from "./PersonChoiceCard.js";
import { playerStatusLabel } from "./youtube-api.js";

const actions: CardActions = {
  decide: () => {},
  registerPlayer: () => () => {},
  reportPlayer: () => {},
  enablePush: async () => ({ ok: true }),
  say: () => {},
  taskAction: () => {},
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
  it("shows a confirmation as a line that waits for the owner's ok in the chat, without buttons", () => {
    const pending = render(confirm("pending"));
    expect(pending).toContain("Esperando tu OK");
    expect(pending).toContain("Para: ana@example.com");
    expect(pending).toContain("Decime «ok»");
    expect(pending).not.toContain("<button");
    expect(render(confirm("confirmed"))).toContain("Confirmado");
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

  it("renders the pairing code, a QR drawn locally from the raw payload, and an image QR as is", () => {
    const html = render({ kind: "pairing", provider: "whatsapp", code: "ABCD-1234", qr: "2@ficticio,AbCdEf,ZyXwVu,1", expiresAt: future });
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("<svg");
    expect(html).not.toContain("ficticio");
    const withImage = render({ kind: "pairing", provider: "whatsapp", qr: "data:image/png;base64,AAAA", expiresAt: future });
    expect(withImage).toContain("<img");
  });

  it("hides the pairing material once it expired", () => {
    const html = render({ kind: "pairing", provider: "whatsapp", code: "ABCD-1234", qr: "2@ficticio,AbCdEf,ZyXwVu,1", expiresAt: past });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("ABCD-1234");
    expect(html).toContain("Venció");
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

describe("youtube card when playback is blocked", () => {
  it("always offers a visible link to open the video on YouTube", () => {
    const html = render({
      kind: "youtube",
      requestId: "r1",
      videoId: "dQw4w9WgXcQ",
      title: "Video de ejemplo",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      autoplay: true,
    });
    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).toContain("Abrir en YouTube");
    expect(playerStatusLabel("blocked")).toMatch(/Tocá reproducir/);
  });

  it("offers to ship a task on a repository or a new project and links the result", () => {
    const base = {
      kind: "task" as const,
      taskId: "3f0c6f53-9a0e-4c4e-9a43-2e0a8a5f1b10",
      ref: 8,
      title: "Agregar login",
      phase: null,
      paused: false,
      iteration: 1,
      costUsd: 0.3,
      budgetUsd: 5,
      updatedAt: "2026-11-25T15:00:00.000Z",
    };
    const repo = render({ ...base, status: "ready", target: { kind: "github", repo: "owner/app", base: "main" } });
    expect(repo).toContain("Repositorio owner/app");
    expect(repo).not.toContain("<button");

    const failed = render({ ...base, status: "accepted", target: { kind: "new", name: "mi-app" }, publication: { status: "failed", message: "Vercel falló" } });
    expect(failed).toContain("Reintentar publicación");

    const shipped = render({
      ...base,
      status: "accepted",
      target: { kind: "new", name: "mi-app" },
      publication: { status: "published", url: "https://mi-app.example.test" },
    });
    expect(shipped).toContain('href="https://mi-app.example.test/"');
    expect(shipped).not.toContain("<button");
  });

  it("shows a task's state, review evidence and only the actions that fit it", () => {
    const base = {
      kind: "task" as const,
      taskId: "3f0c6f53-9a0e-4c4e-9a43-2e0a8a5f1b10",
      ref: 7,
      title: "Corregir el descuento",
      phase: null,
      paused: false,
      iteration: 2,
      costUsd: 0.42,
      budgetUsd: 5,
      updatedAt: "2026-11-20T15:00:00.000Z",
    };
    const ready = render({
      ...base,
      status: "ready",
      summary: "Corregí la fórmula.",
      review: { verdict: "approve", passed: 4, total: 4 },
      deliverables: [{ path: "CHANGES.md", description: "resumen" }],
    });
    expect(ready).toContain("Tarea #7");
    expect(ready).toContain("Lista para revisar");
    expect(ready).toContain("4 de 4 criterios");
    expect(ready).toContain("/api/tasks/7/files?path=CHANGES.md");
    expect(ready).not.toContain("<button");

    const approval = render({
      ...base,
      status: "awaiting_owner",
      phase: "execute",
      blocker: { kind: "approval", message: "Desplegar a staging", approvalId: "8e1f2a7c-1b2c-4d3e-8f90-123456789abc" },
    });
    expect(approval).toContain("Pide tu aprobación");
    expect(approval).toContain("Desplegar a staging");
    expect(approval).toContain("Aprobar");

    const running = render({ ...base, status: "running", phase: "review" });
    expect(running).toContain("Trabajando · revisión");
    expect(running).not.toContain("<button");
    const publishing = render({ ...base, status: "accepted", build: true, publication: { status: "running", step: "checks" } });
    expect(publishing).toContain("Publicando · chequeo completo");
    const published = render({ ...base, status: "accepted", build: true, publication: { status: "published", commit: "abc1234def56" } });
    expect(published).toContain("Publicado en producción · commit abc1234");
    const failedBuild = render({ ...base, status: "accepted", build: true, publication: { status: "failed", step: "checks", message: "No pasó los tests" } });
    expect(failedBuild).toContain("No se publicó: No pasó los tests");
    expect(failedBuild).toContain("Reintentar publicación");
  });

  it("renders a table with every column even when a row is short, and a chart container", () => {
    const table = render({ kind: "table", title: "Tareas", columns: ["#", "Estado", "Nota"], rows: [["1", "Lista"]] });
    expect(table).toContain("<th scope=\"col\">Estado</th>");
    expect(table.match(/<td>/g)).toHaveLength(3);
    const chart = render({ kind: "chart", title: "Avance", chart: "progress", labels: ["#1"], series: [{ name: "Avance", values: [60] }], unit: "%" });
    expect(chart).toContain("Gráfico: Avance");
    expect(chart).toContain("Avance: 60");
  });
});

describe("person choice card", () => {
  it("lists who the owner may mean and turns a pick into what the owner would say", () => {
    const card = {
      kind: "person_choice" as const,
      query: "lu",
      options: [
        { chatId: "5491100000001@s.whatsapp.net", name: "Lu Gómez", detail: "+5491100000001 · hablaron ayer" },
        { chatId: "99887766@lid", name: "Lucía", detail: "nunca hablaron por privado · escribe en «Fútbol jueves»" },
      ],
    };
    const html = renderToStaticMarkup(<CardView card={card} actions={actions} />);
    expect(html).toContain("¿Cuál lu?");
    expect(html).toContain("hablaron ayer");
    expect(html.match(/Es esta/g)).toHaveLength(2);
    expect(personPick(card.options[0]!)).toBe("Es Lu Gómez (+5491100000001).");
    expect(personPick(card.options[1]!)).toBe("Es Lucía (99887766@lid).");
  });
});
