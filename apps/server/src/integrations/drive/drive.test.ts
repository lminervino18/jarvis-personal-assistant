import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../attachments/attachment-store.js";
import { openMigratedDatabase } from "../../db/database.js";
import { toolsByName } from "../../tools/index.js";
import { runTool } from "../../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../../tools/types.js";
import { TransferStore } from "../../transfers/transfer-store.js";
import { DriveClient, parseDriveLink, type DriveFile } from "./drive-client.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A tiny Drive: files by id, with folders, Google Docs and permissions. */
function fakeDrive() {
  const files = new Map<string, DriveFile & { data?: Buffer; appProperties?: Record<string, string>; permissions?: object[] }>();
  files.set("FOLDERshared1", { id: "FOLDERshared1", name: "Fotos de Gero", mimeType: "application/vnd.google-apps.folder" });
  files.set("PHOTO1aaaaaa", { id: "PHOTO1aaaaaa", name: "playa.jpg", mimeType: "image/jpeg", size: "4", parents: ["FOLDERshared1"], data: Buffer.from("jpeg") });
  files.set("DOC1bbbbbbbb", { id: "DOC1bbbbbbbb", name: "Itinerario", mimeType: "application/vnd.google-apps.document", parents: ["FOLDERshared1"] });
  let next = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const id = url.pathname.split("/files/")[1]?.split("/")[0];
    if (url.pathname.endsWith("/export")) return new Response("PDF-BYTES");
    if (url.searchParams.get("alt") === "media") return new Response(files.get(id as string)?.data ?? Buffer.alloc(0));
    if (url.pathname.endsWith("/permissions")) {
      files.get(id as string)?.permissions?.push(JSON.parse(String(init?.body)));
      return json({ id: "perm" });
    }
    if (method === "GET" && !id) {
      const q = url.searchParams.get("q") ?? "";
      const parent = q.match(/'([\w-]+)' in parents/)?.[1];
      const matches = [...files.values()].filter((file) => (q.includes("jarvisRoot") ? file.appProperties?.jarvisRoot === "true" : parent ? file.parents?.includes(parent) : true));
      return json({ files: matches });
    }
    if (method === "GET") return files.has(id as string) ? json(files.get(id as string)) : json({}, 404);
    if (method === "POST" && url.pathname.includes("/upload/")) {
      const body = Buffer.from(init?.body as Uint8Array).toString();
      const meta = JSON.parse(body.split("\r\n\r\n")[1]?.split("\r\n")[0] ?? "{}");
      const created = { id: `UP${++next}xxxxxxxxx`, name: meta.name, mimeType: "image/png", parents: meta.parents, webViewLink: "https://drive.example/up" };
      files.set(created.id, created);
      return json(created);
    }
    if (method === "POST") {
      const meta = JSON.parse(String(init?.body));
      const created = { id: `NEW${++next}xxxxxxxx`, ...meta, permissions: [], webViewLink: `https://drive.example/${next}` };
      files.set(created.id, created);
      return json(created);
    }
    return json({}, 400);
  }) as typeof fetch;
  return { files, fetchFn };
}

function setup(ready = true) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-drive-"));
  dirs.push(dir);
  const db = openMigratedDatabase(":memory:");
  const attachments = new AttachmentStore(db, dir);
  const drive = fakeDrive();
  const transfersDir = join(dir, "transfers");
  mkdirSync(transfersDir);
  const transfers = new TransferStore(db);
  const client = new DriveClient({ get: async () => "token", invalidate: () => {} }, drive.fetchFn);
  const ctx: ToolContext = {
    services: {
      db,
      timezone: "America/Argentina/Buenos_Aires",
      backupRetentionDays: 30,
      statusSources: [],
      attachments,
      drive: { client, ready: () => ready },
      transfers: { store: transfers, dir: transfersDir, publicOrigin: "https://jarvis.example" },
    },
    conversationId: "c1",
    turnId: "t1",
    now: () => new Date(),
    security: { tainted: false, taintSources: new Set<string>() },
    emitCard: () => {},
    emitPlayerCommand: () => {},
  };
  const call = (name: string, input: object) => runTool(ctx, toolsByName.get(name as never) as AnyToolDefinition, input);
  return { ...drive, attachments, transfers, transfersDir, call };
}

describe("Drive links", () => {
  it("reads file, folder and Docs links, with the resource key of old shared links", () => {
    expect(parseDriveLink("https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing")).toEqual({ id: "1AbCdEfGhIjK" });
    expect(parseDriveLink("https://drive.google.com/drive/folders/1FoLdErIdXyZ?resourcekey=0-key")).toEqual({ id: "1FoLdErIdXyZ", resourceKey: "0-key" });
    expect(parseDriveLink("https://docs.google.com/document/d/1DoCiDxxxxxx/edit")).toEqual({ id: "1DoCiDxxxxxx" });
    expect(parseDriveLink("https://drive.google.com/open?id=1OpEnIdxxxxx")).toEqual({ id: "1OpEnIdxxxxx" });
    expect(parseDriveLink("https://evil.example/file/d/1AbCdEfGhIjK")).toBeUndefined();
  });
});

describe("Drive tools", () => {
  it("keeps things in one Jarvis folder, uploads chat files there and shares them with a public link", async () => {
    const { call, attachments, files } = setup();
    const folder = await call("drive_create_folder", { name: "Fotos para Carme" });
    expect(folder).toMatchObject({ ok: true, items: [{ name: "Fotos para Carme", kind: "folder" }] });
    const created = [...files.values()];
    const root = created.find((file) => file.appProperties?.jarvisRoot === "true");
    expect(root?.name).toBe("Jarvis");
    await call("drive_create_folder", { name: "Otra" });
    expect([...files.values()].filter((file) => file.appProperties?.jarvisRoot === "true")).toHaveLength(1);

    const photo = attachments.save({ name: "foto.png", mediaType: "image/png", data: Buffer.from("png") }, new Date());
    const folderId = (folder as { items: { id: string }[] }).items[0]?.id as string;
    const uploaded = await call("drive_upload", { attachmentIds: [photo!.id], folderId });
    expect(uploaded).toMatchObject({ ok: true, items: [{ name: "foto.png" }] });
    expect(files.get((uploaded as { items: { id: string }[] }).items[0]?.id as string)?.parents).toEqual([folderId]);

    const shared = await call("drive_share", { fileId: folderId, anyone: true });
    expect(shared).toMatchObject({ ok: true });
    expect(files.get(folderId)?.permissions).toEqual([{ type: "anyone", role: "reader" }]);
  });

  it("downloads every file of a shared folder link into the chat, exporting Google Docs as PDF", async () => {
    const { call, attachments } = setup();
    const result = (await call("drive_download", { link: "https://drive.google.com/drive/folders/FOLDERshared1" })) as { ok: true; items: { attachmentId: string; name: string }[] };
    expect(result.items.map((item) => item.name).sort()).toEqual(["Itinerario.pdf", "playa.jpg"]);
    const doc = result.items.find((item) => item.name === "Itinerario.pdf");
    expect(attachments.read(doc!.attachmentId)?.data.toString()).toBe("PDF-BYTES");
  });

  it("sends a file too big for the chat to Transferencias, in original quality", async () => {
    const { call, files, transfers, transfersDir } = setup();
    files.set("VIDEObig0001", { id: "VIDEObig0001", name: "partido.mp4", mimeType: "video/mp4", size: String(80 * 1024 * 1024), data: Buffer.from("match bytes") });
    const result = (await call("drive_download", { link: "https://drive.google.com/file/d/VIDEObig0001/view" })) as { ok: true; items: { transferId?: string; attachmentId?: string; where?: string }[] };
    expect(result.items).toMatchObject([{ where: "Transferencias", name: "partido.mp4" }]);
    const kept = transfers.get(result.items[0]!.transferId!, new Date());
    expect(kept).toMatchObject({ sender: "Google Drive", size: 11 });
    expect(readFileSync(join(transfersDir, kept!.uploadId), "utf8")).toBe("match bytes");
  });

  it("asks to reconnect Google when the account never granted Drive access", async () => {
    const { call } = setup(false);
    expect(await call("drive_search", {})).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });
});
