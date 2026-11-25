import { randomUUID } from "node:crypto";
import type { Card } from "@jarvis/contracts";
import type { AttachmentStore } from "../attachments/attachment-store.js";
import type { Outbox } from "../worker/outbox.js";

const API = "https://api.openai.com/v1/images";
const DEFAULT_MODEL = "gpt-image-2";
const TIMEOUT_MS = 3 * 60_000;
const NOTIFICATION_TITLE = "J.A.R.V.IS";

const SIZES = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" } as const;

export type ImageQuality = "low" | "medium" | "high";
export type ImageFormat = keyof typeof SIZES;

export interface ImageRequest {
  prompt: string;
  referenceIds: string[];
  quality: ImageQuality;
  format: ImageFormat;
  /** A resolved WhatsApp chat that gets the image when it is ready. */
  sendTo?: { jid: string; name: string; text?: string };
}

export interface ImageServiceDeps {
  apiKey: string;
  attachments: AttachmentStore;
  outbox: Outbox;
  /** Queues the image for a WhatsApp chat; the bridge sends it at most once. */
  sendWhatsApp(input: { jid: string; text: string; attachmentId: string }): void;
  log: { info(data: object, message: string): void; warn(data: object, message: string): void };
  model?: string;
  fetchFn?: typeof fetch;
  now?(): Date;
}

/** A refusal or failure from OpenAI, in words the owner can act on. */
export class ImageError extends Error {}

function failure(status: number, code: string | undefined): string {
  if (code === "insufficient_quota" || code === "credit_balance_exhausted") return "OpenAI no tiene crédito: cargalo en platform.openai.com › Billing.";
  if (code === "moderation_blocked" || code === "content_policy_violation") return "OpenAI rechazó el pedido por su política de contenido.";
  if (status === 401 || status === 403) return "OpenAI no aceptó la clave de la API.";
  if (status === 429) return "OpenAI está limitando los pedidos; probá en un rato.";
  return "OpenAI no pudo generar la imagen.";
}

/** Generates images with OpenAI in the background and leaves them in the chat (and WhatsApp when asked). */
export class ImageService {
  private readonly jobs = new Set<Promise<void>>();

  constructor(private readonly deps: ImageServiceDeps) {}

  /** Starts one generation and returns at once; the chat hears when it ends. */
  start(request: ImageRequest): string {
    const id = randomUUID();
    const job = this.generate(id, request).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
    return id;
  }

  /** Resolves when every running generation ended (for tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.jobs]);
  }

  private async generate(id: string, request: ImageRequest): Promise<void> {
    const started = Date.now();
    try {
      const data = await this.call(request);
      const saved = this.deps.attachments.save({ name: `imagen-${id.slice(0, 8)}.png`, mediaType: "image/png", data }, this.now());
      if (!saved) throw new ImageError("No pude guardar la imagen.");
      this.deps.log.info({ quality: request.quality, references: request.referenceIds.length, ms: Date.now() - started }, "image created");
      const card: Card = { kind: "attachment", attachmentId: saved.id, name: saved.name, mediaType: saved.mediaType, size: saved.size };
      if (request.sendTo) this.deps.sendWhatsApp({ jid: request.sendTo.jid, text: request.sendTo.text ?? "", attachmentId: saved.id });
      const sent = request.sendTo ? ` y se la mandé a ${request.sendTo.name}` : "";
      this.notify(`image-ready:${id}`, { text: `Lista la imagen${sent}. [imagen ${saved.id}]`, cards: [card] }, `Lista la imagen${sent}`);
    } catch (error) {
      const message = error instanceof ImageError ? error.message : "No pude generar la imagen.";
      this.deps.log.warn({ err: message }, "image failed");
      this.notify(`image-failed:${id}`, { text: `No pude hacer la imagen: ${message}`, cards: [] }, "No pude hacer la imagen");
    }
  }

  private async call(request: ImageRequest): Promise<Buffer> {
    const model = this.deps.model ?? DEFAULT_MODEL;
    const fields = { model, prompt: request.prompt, size: SIZES[request.format], quality: request.quality, n: "1" };
    let body: FormData | string;
    let headers: Record<string, string> = { authorization: `Bearer ${this.deps.apiKey}` };
    let url = `${API}/generations`;
    if (request.referenceIds.length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      for (const reference of request.referenceIds) {
        const file = this.deps.attachments.read(reference);
        if (!file) throw new ImageError("No encontré una de las fotos de referencia.");
        form.append("image[]", new Blob([new Uint8Array(file.data)], { type: file.attachment.mediaType }), file.attachment.name);
      }
      body = form;
      url = `${API}/edits`;
    } else {
      body = JSON.stringify({ ...fields, n: 1 });
      headers = { ...headers, "content-type": "application/json" };
    }
    let response: Response;
    try {
      response = await (this.deps.fetchFn ?? fetch)(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ImageError("OpenAI no respondió a tiempo.");
    }
    const json = (await response.json().catch(() => undefined)) as { data?: { b64_json?: string }[]; error?: { code?: string } } | undefined;
    if (!response.ok) throw new ImageError(failure(response.status, json?.error?.code));
    const encoded = json?.data?.[0]?.b64_json;
    if (!encoded) throw new ImageError("OpenAI no devolvió ninguna imagen.");
    return Buffer.from(encoded, "base64");
  }

  private notify(key: string, chat: { text: string; cards: Card[] }, push: string): void {
    const now = this.now();
    this.deps.outbox.enqueue({ kind: "chat_message", dedupeKey: `${key}:chat`, payload: chat }, now);
    this.deps.outbox.enqueue({ kind: "push", dedupeKey: `${key}:push`, payload: { title: NOTIFICATION_TITLE, body: push, tag: key, url: "/" } }, now);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
