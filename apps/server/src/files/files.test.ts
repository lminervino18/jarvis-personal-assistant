import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../attachments/attachment-store.js";
import { TokenCipher } from "../crypto/token-cipher.js";
import { openMigratedDatabase } from "../db/database.js";
import { mediaOf } from "../integrations/whatsapp/message-mapper.js";
import { WhatsAppReader } from "../integrations/whatsapp/message-reader.js";
import { WhatsAppStore } from "../integrations/whatsapp/message-store.js";
import { buildPagesServer } from "../pages/pages-server.js";
import type { PageService } from "../pages/page-service.js";
import { analyzeFile, fileFamily } from "./file-analysis.js";
import { FileLinks } from "./file-links.js";
import { FileTooLargeError, WhatsAppFiles, type MediaDownloader } from "./whatsapp-files.js";

const NOW = new Date("2026-11-23T12:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attachmentsFixture() {
  const db = openMigratedDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "jarvis-files-"));
  dirs.push(dir);
  return { db, attachments: new AttachmentStore(db, dir) };
}

function xlsx(rows: string[][]): Buffer {
  const cells = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`)
    .join("");
  const files = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(files));
}

describe("file analysis", () => {
  it("knows each family by type, and by extension when the type is generic", () => {
    expect(fileFamily({ name: "nota.ogg", mediaType: "audio/ogg; codecs=opus" })).toBe("audio");
    expect(fileFamily({ name: "clip.mp4", mediaType: "application/octet-stream" })).toBe("video");
    expect(fileFamily({ name: "ventas.xlsx", mediaType: "application/octet-stream" })).toBe("spreadsheet");
    expect(fileFamily({ name: "datos.csv", mediaType: "text/csv" })).toBe("text");
    expect(fileFamily({ name: "app.apk", mediaType: "application/vnd.android.package-archive" })).toBe("other");
  });

  it("shows photos as images and reads text, Excel and Word files as text", async () => {
    const photo = await analyzeFile({ name: "foto.jpg", mediaType: "image/jpeg", data: Buffer.from("jpeg") });
    expect(photo.images).toEqual([{ mediaType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") }]);

    const csv = await analyzeFile({ name: "datos.csv", mediaType: "text/csv", data: Buffer.from("producto,monto\nyerba,2500") });
    expect(csv.text).toContain("yerba,2500");

    const sheet = await analyzeFile({ name: "ventas.xlsx", mediaType: "application/octet-stream", data: xlsx([["Producto", "Monto"], ["Yerba", "2500"]]) });
    expect(sheet.text).toContain("Hoja «Ventas» (2 filas)");
    expect(sheet.text).toContain("Yerba | 2500");

    const word = Buffer.from(zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Hola &amp; chau</w:t></w:r></w:p><w:p><w:r><w:t>Segunda</w:t></w:r></w:p></w:body></w:document>') }));
    expect((await analyzeFile({ name: "carta.docx", mediaType: "application/octet-stream", data: word })).text).toBe("Hola & chau\nSegunda");
  });

  it("transcribes audio, reads PDFs with pdftotext and turns a video into frames plus the transcript of its sound", async () => {
    const stt = { transcribeFile: async () => "nos vemos a las cinco" };
    const calls: string[] = [];
    const exec = async (command: string, args: string[]) => {
      calls.push(command);
      if (command === "ffprobe") return { stdout: "12.0\n" };
      if (command === "pdftotext") return { stdout: "Factura 0001\nTotal: $ 5000" };
      const output = args.at(-1) as string;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, output.endsWith(".jpg") ? Buffer.from("frame") : Buffer.from("opus"));
      return { stdout: "" };
    };
    expect((await analyzeFile({ name: "nota.ogg", mediaType: "audio/ogg; codecs=opus", data: Buffer.from("ogg") }, { stt })).text).toBe("Transcripción del audio: nos vemos a las cinco");
    expect((await analyzeFile({ name: "factura.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF") }, { exec })).text).toContain("Total: $ 5000");
    const video = await analyzeFile({ name: "clip.mp4", mediaType: "video/mp4", data: Buffer.from("mp4") }, { stt, exec });
    expect(video.images).toHaveLength(4);
    expect(video.text).toContain("Video de 12 s");
    expect(video.text).toContain("nos vemos a las cinco");
    expect(calls.filter((command) => command === "ffmpeg")).toHaveLength(5);
  });

  it("leaves a note for files it cannot read inside, and for broken ones", async () => {
    expect((await analyzeFile({ name: "app.apk", mediaType: "application/zip", data: Buffer.from("x") })).note).toContain("reenviar o compartir");
    expect((await analyzeFile({ name: "roto.xlsx", mediaType: "application/octet-stream", data: Buffer.from("no es un zip") })).note).toContain("No pude leer");
  });
});

describe("WhatsApp files", () => {
  function setup(download: MediaDownloader) {
    const { db, attachments } = attachmentsFixture();
    const cipher = new TokenCipher(randomBytes(32));
    const store = new WhatsAppStore(db, cipher);
    store.upsertChat({ jid: "5491100000000@s.whatsapp.net", name: "Ana", isGroup: false }, NOW);
    const media = mediaOf({ documentMessage: { mimetype: "text/csv", fileName: "ventas.csv", fileLength: 20, mediaKey: new Uint8Array([1, 2, 3]), directPath: "/v/t62/abc" } });
    store.insertMessages([{ id: "M1", chatJid: "5491100000000@s.whatsapp.net", senderJid: null, senderName: "Ana", fromMe: false, tsUtc: NOW.toISOString(), text: "", kind: "media", source: "baileys", ...(media ? { media } : {}) }], NOW);
    return { db, attachments, files: new WhatsAppFiles(db, cipher, attachments, download) };
  }

  it("keeps only an encrypted locator when a file arrives and downloads it once, on request", async () => {
    const seen: unknown[] = [];
    const { db, attachments, files } = setup(async (locator, kind) => {
      seen.push({ locator, kind });
      return Buffer.from("producto,monto");
    });
    const raw = db.prepare("SELECT locator_enc FROM wa_media").get() as { locator_enc: string };
    expect(raw.locator_enc).not.toContain("/v/t62/abc");
    expect(files.describe("5491100000000@s.whatsapp.net", "M1")).toMatchObject({ kind: "document", fileName: "ventas.csv", attachmentId: null });

    const first = await files.fetch("5491100000000@s.whatsapp.net", "M1", NOW);
    const second = await files.fetch("5491100000000@s.whatsapp.net", "M1", NOW);
    expect(first.ok && second.ok && first.attachment.id === second.attachment.id).toBe(true);
    expect(seen).toEqual([{ locator: { mediaKey: Buffer.from([1, 2, 3]).toString("base64"), directPath: "/v/t62/abc", url: null }, kind: "document" }]);
    expect(first.ok ? attachments.read(first.attachment.id)?.data.toString() : "").toBe("producto,monto");
  });

  it("shows in chat reads which messages carry a file, so the model can ask for it", () => {
    const { db } = setup(async () => Buffer.from(""));
    const page = new WhatsAppReader(db, "America/Argentina/Buenos_Aires").messages({ chatId: "5491100000000@s.whatsapp.net", limit: 5 });
    expect(page.items[0]?.file).toEqual({ kind: "document", name: "ventas.csv", mediaType: "text/csv", size: 20, seconds: null, voiceNote: false, downloadable: true });
  });

  it("explains files that are gone from WhatsApp, too large, or not files at all", async () => {
    expect(await setup(async () => Promise.reject(Object.assign(new Error("gone"), { output: { statusCode: 410 } }))).files.fetch("5491100000000@s.whatsapp.net", "M1", NOW)).toEqual({ ok: false, reason: "expired" });
    expect(await setup(async () => Promise.reject(new FileTooLargeError())).files.fetch("5491100000000@s.whatsapp.net", "M1", NOW)).toEqual({ ok: false, reason: "too_large" });
    expect(await setup(async () => Buffer.from("x")).files.fetch("5491100000000@s.whatsapp.net", "OTHER", NOW)).toEqual({ ok: false, reason: "not_media" });
  });
});

describe("shared file links", () => {
  async function serve() {
    const { db, attachments } = attachmentsFixture();
    const links = new FileLinks(db);
    const video = attachments.save({ name: "fiesta.mp4", mediaType: "video/mp4", data: Buffer.from("0123456789") }, NOW)!;
    const apk = attachments.save({ name: "app.apk", mediaType: "application/vnd.android.package-archive", data: Buffer.from("apk") }, NOW)!;
    let clock = NOW;
    const server = buildPagesServer({} as PageService, {
      trustProxy: false,
      sharedFile: (token) => {
        const id = links.resolve(token, clock);
        const stored = id ? attachments.read(id) : undefined;
        return stored ? { name: stored.attachment.name, mediaType: stored.attachment.mediaType, data: stored.data } : undefined;
      },
    });
    return { server, links, video, apk, later: (ms: number) => void (clock = new Date(NOW.getTime() + ms)) };
  }

  it("serves the original file with byte ranges, so phones can play videos", async () => {
    const { server, links, video } = await serve();
    const { token } = links.create(video.id, NOW);
    const full = await server.inject({ method: "GET", url: `/d/${token}` });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.headers["content-disposition"]).toContain("inline");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const part = await server.inject({ method: "GET", url: `/d/${token}`, headers: { range: "bytes=2-5" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(part.body).toBe("2345");
    expect((await server.inject({ method: "GET", url: `/d/${token}`, headers: { range: "bytes=50-" } })).statusCode).toBe(416);
    await server.close();
  });

  it("downloads anything that is not safe to preview, and stops working after seven days", async () => {
    const { server, links, apk, later } = await serve();
    const { token, expiresAt } = links.create(apk.id, NOW);
    expect(expiresAt).toBe("2026-11-30T12:00:00.000Z");
    const response = await server.inject({ method: "GET", url: `/d/${token}` });
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["content-security-policy"]).toBe("sandbox");
    later(7 * 86_400_000 + 1);
    expect((await server.inject({ method: "GET", url: `/d/${token}` })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/d/short" })).statusCode).toBe(404);
    await server.close();
  });
});
