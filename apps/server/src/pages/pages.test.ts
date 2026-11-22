import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { ScriptedRuntime } from "../runtime/scripted-runtime.js";
import { Outbox } from "../worker/outbox.js";
import { ALLOWED_SCRIPTS } from "./design-guide.js";
import { extractHtml, pageProblems, withRuntime } from "./page-html.js";
import { cleanResponse, PageService } from "./page-service.js";
import { PageStore } from "./page-store.js";
import { buildPagesServer } from "./pages-server.js";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { toolsByName } from "../tools/index.js";
import { runTool } from "../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../tools/types.js";

const silent = { info: () => {}, warn: () => {} };
const page = (body: string, head = "") => `<!doctype html><html lang="es"><head><title>Cena</title>${head}</head><body>${body}</body></html>`;
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function setup(reply: () => string = () => page("<h1>Cena</h1>")) {
  const db = openMigratedDatabase(":memory:");
  const runtime = new ScriptedRuntime();
  runtime.completer = reply;
  const dir = mkdtempSync(join(tmpdir(), "jarvis-pages-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const attachments = new AttachmentStore(db, dir);
  const service = new PageService({ store: new PageStore(db), attachments, runtime, outbox: new Outbox(db), baseUrl: "https://p.example.test/", log: silent });
  const outbox = () => db.prepare("SELECT kind, payload_json FROM outbox ORDER BY created_at, rowid").all() as { kind: string; payload_json: string }[];
  const server = buildPagesServer(service, { trustProxy: false });
  closers.push(() => server.close());
  return { db, runtime, service, outbox, server, attachments };
}

describe("page html", () => {
  it("takes the document out of a chatty reply", () => {
    expect(extractHtml(`Acá va:\n${page("hola")}\nListo.`)).toBe(page("hola"));
    expect(extractHtml("no hay html")).toBeUndefined();
  });

  it("only allows the listed scripts and Google Fonts", () => {
    expect(pageProblems(page(`<script src="${ALLOWED_SCRIPTS[0]}"></script>`, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'))).toEqual([]);
    expect(pageProblems(page('<script src="https://evil.example/x.js"></script>'))).toHaveLength(1);
    expect(pageProblems(page("", '<link rel="stylesheet" href="https://evil.example/x.css">'))).toHaveLength(1);
    expect(pageProblems(page('<iframe src="https://x"></iframe>'))).toHaveLength(1);
  });

  it("adds the submit runtime inside the head", () => {
    expect(withRuntime(page("x"), "cena-1a2b3")).toMatch(/<head><script>window\.jarvis=.*\/r\/cena-1a2b3.*<\/script><title>/);
  });

  it("accepts flat answers and refuses anything else", () => {
    expect(cleanResponse({ nombre: "Ana", viene: true, invitados: 2, trae: ["vino"] })).toEqual({ nombre: "Ana", viene: true, invitados: 2, trae: ["vino"] });
    expect(cleanResponse({ "bad key": 1 })).toBeUndefined();
    expect(cleanResponse({ nested: { a: 1 } })).toBeUndefined();
    expect(cleanResponse([1, 2])).toBeUndefined();
    expect(cleanResponse({})).toBeUndefined();
  });
});

describe("pages", () => {
  it("writes the page in the background with the owner's style and tells the owner when it is online", async () => {
    const { service, runtime, outbox, server } = setup();
    let release = () => {};
    const complete = runtime.complete.bind(runtime);
    runtime.complete = (request) => new Promise((resolve) => (release = () => resolve(complete(request))));
    const created = service.create({ title: "Cena del Viernes!", brief: "Invitá a seis amigos a comer pastas" });
    expect(created).toMatchObject({ status: "generating" });
    expect(created.slug).toMatch(/^cena-del-viernes-[0-9a-f]{5}$/);
    expect(service.url(created)).toBe(`https://p.example.test/${created.slug}`);

    const waiting = await server.inject({ method: "GET", url: `/${created.slug}` });
    expect(waiting.body).toContain("se está preparando");

    release();
    await service.settled();
    expect(runtime.completions[0]?.system).toContain("Pulso");
    expect(runtime.completions[0]?.prompt).toContain("Invitá a seis amigos");
    const ready = await server.inject({ method: "GET", url: `/${created.slug}` });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(ready.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(ready.body).toContain("window.jarvis");
    expect(outbox().map((row) => row.kind)).toEqual(["chat_message", "push"]);
    expect(JSON.parse(outbox()[0]!.payload_json)).toMatchObject({ text: expect.stringContaining(service.url(created)), cards: [{ kind: "link" }] });
  });

  it("puts the owner's photos in the page and serves them only from that page", async () => {
    const { service, runtime, server, attachments } = setup();
    const photo = attachments.save({ name: "quincho.jpg", mediaType: "image/jpeg", data: Buffer.from("jpeg") }, new Date())!;
    const pdf = attachments.save({ name: "menu.pdf", mediaType: "application/pdf", data: Buffer.from("pdf") }, new Date())!;
    expect(service.unusableImages([photo.id, pdf.id])).toEqual([pdf.id]);
    const created = service.create({ title: "Asado", brief: "Invitación con la foto del quincho", attachmentIds: [photo.id] });
    const other = service.create({ title: "Otra", brief: "Sin fotos" });
    await service.settled();
    expect(runtime.completions[0]?.prompt).toContain(`/${created.slug}/f/${photo.id}`);
    const image = await server.inject({ method: "GET", url: `/${created.slug}/f/${photo.id}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/jpeg");
    expect((await server.inject({ method: "GET", url: `/${other.slug}/f/${photo.id}` })).statusCode).toBe(404);
  });

  it("retries once naming what was wrong, then gives up without publishing", async () => {
    const replies = [page('<script src="https://evil.example/x.js"></script>'), page("<p>bien</p>")];
    const { service, runtime } = setup(() => replies.shift() ?? "nada");
    const created = service.create({ title: "Encuesta", brief: "preguntá colores" });
    await service.settled();
    expect(runtime.completions[1]?.prompt).toContain("script no permitido");
    expect(service.get(created.slug)).toMatchObject({ status: "ready", version: 1 });

    const broken = setup(() => "no html");
    const failed = broken.service.create({ title: "Rota", brief: "x" });
    await broken.service.settled();
    expect(broken.service.get(failed.slug)).toMatchObject({ status: "failed", html: null });
    expect(JSON.parse(broken.outbox()[0]!.payload_json).text).toContain("No pude armar la página «Rota»");
  });

  it("keeps the published version online while a change is written, and if the change fails", async () => {
    const { service, server } = setup();
    const created = service.create({ title: "Cena", brief: "pastas" });
    await service.settled();
    const runtime = (service as unknown as { deps: { runtime: ScriptedRuntime } }).deps.runtime;
    runtime.completer = () => "no html";
    service.update(service.get(created.slug)!, "cambiá la hora");
    expect((await server.inject({ method: "GET", url: `/${created.slug}` })).body).toContain("<h1>Cena</h1>");
    await service.settled();
    expect(runtime.completions.at(-1)?.prompt).toContain("Página actual:");
    expect(service.get(created.slug)).toMatchObject({ status: "ready", version: 1, html: expect.stringContaining("<h1>Cena</h1>") });
  });

  it("stores answers and notifies the owner without putting them in the push", async () => {
    const { service, server, outbox } = setup();
    const created = service.create({ title: "Cena", brief: "pastas" });
    await service.settled();
    const answer = await server.inject({ method: "POST", url: `/r/${created.slug}`, payload: { nombre: "Ana", viene: "si" } });
    expect(answer.statusCode).toBe(204);
    expect(service.responses(service.get(created.slug)!, 10)).toMatchObject([{ data: { nombre: "Ana", viene: "si" } }]);
    const [chat, push] = outbox().slice(-2).map((row) => JSON.parse(row.payload_json));
    expect(chat.text).toContain("Nueva respuesta en «Cena» (1 en total): nombre: Ana · viene: si");
    expect(push.body).toBe("Nueva respuesta en «Cena»");

    expect((await server.inject({ method: "POST", url: `/r/${created.slug}`, payload: { "mal key": 1 } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/r/no-existe", payload: { a: 1 } })).statusCode).toBe(404);
  });

  it("limits how fast one visitor can answer", async () => {
    const { service, server } = setup();
    const created = service.create({ title: "Cena", brief: "pastas" });
    await service.settled();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await server.inject({ method: "POST", url: `/r/${created.slug}`, payload: { n: i } })).statusCode);
    expect(codes.filter((code) => code === 204)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });

  it("shows a plain 404 for unknown pages", async () => {
    const { server } = setup();
    const missing = await server.inject({ method: "GET", url: "/no-existe-123" });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("no existe");
  });
});

describe("page tools", () => {
  function context(service: PageService | undefined, db: ReturnType<typeof openMigratedDatabase>): ToolContext {
    return {
      services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], ...(service ? { pages: service } : {}) },
      conversationId: "c1",
      turnId: "t1",
      now: () => new Date(),
      security: { tainted: false, taintSources: new Set() },
      emitCard: () => {},
      emitPlayerCommand: () => {},
    };
  }
  const tool = (name: string) => toolsByName.get(name as never) as AnyToolDefinition;

  it("returns the link at once and says the page is being written in the background", async () => {
    const { service, db } = setup();
    const result = await runTool(context(service, db), tool("page_create"), { title: "Cena", brief: "pastas el viernes" });
    expect(result).toMatchObject({ ok: true, items: [{ status: "generating", url: expect.stringMatching(/^https:\/\/p\.example\.test\/cena-/) }] });
    expect(result.ok && result.note).toContain("segundo plano");
    await service.settled();
  });

  it("treats the answers as third-party content", async () => {
    const { service, db, server } = setup();
    const created = service.create({ title: "Cena", brief: "pastas" });
    await service.settled();
    await server.inject({ method: "POST", url: `/r/${created.slug}`, payload: { nombre: "Ana" } });
    const ctx = context(service, db);
    const result = await runTool(ctx, tool("page_responses"), { slug: created.slug });
    expect(result).toMatchObject({ ok: true, items: [{ data: { nombre: "Ana" } }] });
    expect(ctx.security.tainted).toBe(true);
  });

  it("says plainly when pages are not configured", async () => {
    const { db } = setup();
    expect(await runTool(context(undefined, db), tool("page_list"), {})).toMatchObject({ ok: false, error: { code: "disabled" } });
  });
});
