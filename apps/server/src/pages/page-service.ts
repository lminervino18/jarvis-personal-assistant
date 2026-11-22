import { randomBytes } from "node:crypto";
import type { Card, ModelRuntime } from "@jarvis/contracts";
import { NOTIFICATION_TITLE, type PushNotification } from "../push/notification.js";
import type { ChatPayload } from "../worker/chat-messages.js";
import type { Outbox } from "../worker/outbox.js";
import { PAGE_SYSTEM_PROMPT } from "./design-guide.js";
import { extractHtml, pageProblems } from "./page-html.js";
import type { Page, PageStore } from "./page-store.js";

const GENERATION_TIMEOUT_MS = 5 * 60_000;
const SLUG_WORDS_CHARS = 40;
const MAX_RESPONSES_PER_PAGE = 500;
const MAX_RESPONSE_KEYS = 30;
const MAX_TEXT_CHARS = 2000;
const MAX_LIST_ITEMS = 20;
const SUMMARY_CHARS = 300;

export interface PageServiceDeps {
  store: PageStore;
  runtime: ModelRuntime;
  outbox: Outbox;
  baseUrl: string;
  model?: string;
  log: { info(data: object, message: string): void; warn(data: object, message: string): void };
  now?: () => Date;
}

export type ResponseOutcome = { ok: true } | { ok: false; status: 400 | 404 | 409 | 413; message: string };

function slugify(title: string): string {
  const words = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_WORDS_CHARS)
    .replace(/-+$/, "");
  return `${words || "pagina"}-${randomBytes(4).toString("hex").slice(0, 5)}`;
}

/** Answers a page may send: a flat object of short texts, numbers, booleans or lists of texts. */
export function cleanResponse(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_RESPONSE_KEYS) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) return undefined;
    if (typeof value === "string") clean[key] = value.slice(0, MAX_TEXT_CHARS);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) clean[key] = value;
    else if (Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every((item) => typeof item === "string")) clean[key] = value.map((item) => item.slice(0, 200));
    else return undefined;
  }
  return clean;
}

function summarize(data: Record<string, unknown>): string {
  const text = Object.entries(data)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(" · ");
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

/**
 * Web pages the assistant writes for the owner (invitations, surveys, landings). Generation runs
 * in the background with a one-shot model call; the owner hears back through the chat and a
 * push when a page is ready, fails, or gets an answer.
 */
export class PageService {
  private readonly jobs = new Set<Promise<void>>();

  constructor(private readonly deps: PageServiceDeps) {}

  url(page: Pick<Page, "slug">): string {
    return `${this.deps.baseUrl.replace(/\/+$/, "")}/${page.slug}`;
  }

  get(slug: string): Page | undefined {
    return this.deps.store.get(slug);
  }

  list(limit: number) {
    return this.deps.store.list(limit);
  }

  responses(page: Page, limit: number) {
    return this.deps.store.responses(page.id, limit);
  }

  /** Starts writing a new page in the background and returns it right away, still generating. */
  create(input: { title: string; brief: string }): Page {
    const page = this.deps.store.create({ slug: slugify(input.title), title: input.title, brief: input.brief }, this.now());
    this.run(page, `Título: ${input.title}\n\nPedido del dueño:\n${input.brief}`);
    return page;
  }

  /** Rewrites a published page with a change, in the background. The current version stays online meanwhile. */
  update(page: Page, change: string): Page {
    this.deps.store.markGenerating(page.id, this.now());
    const current = page.html ? `Página actual:\n${page.html}\n\n` : `Pedido original:\n${page.brief}\n\n`;
    this.run(page, `${current}Cambio pedido por el dueño:\n${change}`);
    return this.deps.store.require(page.slug);
  }

  /** Stores an answer sent from a page and tells the owner. */
  recordResponse(slug: string, data: unknown): ResponseOutcome {
    const page = this.deps.store.get(slug);
    if (!page || !page.html) return { ok: false, status: 404, message: "not found" };
    const clean = cleanResponse(data);
    if (!clean) return { ok: false, status: 400, message: "invalid answer" };
    if (this.deps.store.responseCount(page.id) >= MAX_RESPONSES_PER_PAGE) return { ok: false, status: 409, message: "page is full" };
    const { id, total } = this.deps.store.addResponse(page.id, clean, this.now());
    this.notify(`page-response:${id}`, {
      chat: { text: `Nueva respuesta en «${page.title}» (${total} en total): ${summarize(clean)}`, cards: [] },
      push: `Nueva respuesta en «${page.title}»`,
    });
    return { ok: true };
  }

  /** Resolves once every generation started so far has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.jobs]);
  }

  private run(page: Page, prompt: string): void {
    const job = this.generate(page, prompt).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }

  private async generate(page: Page, prompt: string): Promise<void> {
    const started = Date.now();
    try {
      const html = await this.write(prompt);
      this.deps.store.publish(page.id, html, this.now());
      const published = this.deps.store.require(page.slug);
      const url = this.url(page);
      this.deps.log.info({ slug: page.slug, version: published.version, ms: Date.now() - started }, "page published");
      const link: Card = { kind: "link", url, title: page.title, description: "Página de JARVIS" };
      this.notify(`page-ready:${page.id}:${published.version}`, {
        chat: { text: `${published.version > 1 ? "Actualicé" : "Ya está"} la página «${page.title}»: ${url}`, cards: [link] },
        push: `La página «${page.title}» está lista`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "error desconocido";
      this.deps.store.fail(page.id, message, this.now());
      this.deps.log.warn({ slug: page.slug, err: message.slice(0, 200) }, "page generation failed");
      this.notify(`page-failed:${page.id}:${Date.now()}`, {
        chat: { text: `No pude armar la página «${page.title}»: ${message}. Pedímela de nuevo, con más detalle si hace falta.`, cards: [] },
        push: `No pude armar la página «${page.title}»`,
      });
    }
  }

  /** One model call, plus one retry that names what was wrong with the first answer. */
  private async write(prompt: string): Promise<string> {
    const { runtime, model } = this.deps;
    if (!runtime.complete) throw new Error("el modelo no está disponible para escribir páginas");
    let request = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await runtime.complete({ system: PAGE_SYSTEM_PROMPT, prompt: request, model, effort: "medium" }, AbortSignal.timeout(GENERATION_TIMEOUT_MS));
      const html = extractHtml(reply);
      const problems = html ? pageProblems(html) : ["no devolvió un documento HTML completo"];
      if (html && problems.length === 0) return html;
      request = `${prompt}\n\nTu versión anterior no se pudo publicar porque ${problems.join("; ")}. Devolvé la página completa corregida.`;
    }
    throw new Error("el modelo no devolvió una página válida");
  }

  private notify(key: string, message: { chat: ChatPayload; push: string }): void {
    const now = this.now();
    const push: PushNotification = { title: NOTIFICATION_TITLE, body: message.push, tag: key.split(":").slice(0, 2).join(":"), url: "/" };
    this.deps.outbox.enqueue({ kind: "chat_message", dedupeKey: `${key}:chat`, payload: message.chat }, now);
    this.deps.outbox.enqueue({ kind: "push", dedupeKey: `${key}:push`, payload: push }, now);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
