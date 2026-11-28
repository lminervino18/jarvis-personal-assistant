import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../../db/database.js";
import { toolsByName } from "../../tools/index.js";
import { runTool } from "../../tools/runner.js";
import type { AnyToolDefinition, ToolContext } from "../../tools/types.js";
import { TransferStore } from "../../transfers/transfer-store.js";
import { DriveClient, receivedBytes, type DriveFile } from "./drive-client.js";
import { contentKey, DriveUploads } from "./drive-uploads.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-drive-up-"));
  dirs.push(dir);
  return dir;
};

type Stored = DriveFile & { appProperties?: Record<string, string>; data?: Buffer };

/** Drive with folders, appProperties queries and resumable sessions; `dropAt` fails one chunk request to simulate a cut. */
function fakeDrive(options: { dropAt?: number } = {}) {
  const files = new Map<string, Stored>([["ROOTjarvis00", { id: "ROOTjarvis00", name: "Jarvis", mimeType: "application/vnd.google-apps.folder", appProperties: { jarvisRoot: "true" } }]]);
  const sessions = new Map<string, { meta: Stored; data: Buffer; size: number }>();
  let next = 0;
  let puts = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "upload.session") {
      const session = sessions.get(url.pathname);
      if (!session) return json({}, 404);
      puts++;
      if (options.dropAt === puts) throw new Error("connection reset");
      const range = new Headers(init?.headers).get("content-range") ?? "";
      const body = Buffer.from((init?.body as Uint8Array) ?? new Uint8Array());
      if (body.length > 0) session.data = Buffer.concat([session.data, body]);
      if (session.data.length >= session.size) {
        const file = { ...session.meta, id: `FILE${++next}xxxxxxx`, size: String(session.size), data: session.data, webViewLink: `https://drive.example/file/${next}` };
        files.set(file.id, file);
        return json(file, 200);
      }
      void range;
      return new Response(null, { status: 308, headers: session.data.length ? { range: `bytes=0-${session.data.length - 1}` } : {} });
    }
    if (method === "POST" && url.searchParams.get("uploadType") === "resumable") {
      const meta = JSON.parse(String(init?.body)) as Stored;
      const path = `/s${++next}`;
      sessions.set(path, { meta, data: Buffer.alloc(0), size: Number(new Headers(init?.headers).get("x-upload-content-length")) });
      return new Response("", { status: 200, headers: { location: `https://upload.session${path}` } });
    }
    const id = url.pathname.split("/files/")[1]?.split("/")[0];
    if (method === "GET" && !id) {
      const q = url.searchParams.get("q") ?? "";
      const parent = q.match(/'([\w-]+)' in parents/)?.[1];
      const name = q.match(/name = '([^']+)'/)?.[1];
      const key = q.match(/key='jarvisKey' and value='([^']+)'/)?.[1];
      const matches = [...files.values()].filter((file) =>
        q.includes("jarvisRoot")
          ? file.appProperties?.jarvisRoot === "true"
          : file.parents?.includes(parent ?? "") && (!name || file.name === name) && (!key || file.appProperties?.jarvisKey === key),
      );
      return json({ files: matches });
    }
    if (method === "GET") return files.has(id ?? "") ? json(files.get(id ?? "")) : json({}, 404);
    if (method === "POST") {
      const created = { ...(JSON.parse(String(init?.body)) as Omit<Stored, "id">), id: `DIR${++next}xxxxxxxx` };
      files.set(created.id, created);
      return json(created);
    }
    return json({}, 400);
  }) as typeof fetch;
  return { files, fetchFn, putCount: () => puts };
}

function setup(drive = fakeDrive()) {
  const transfersDir = tempDir();
  const db = openMigratedDatabase(":memory:");
  const store = new TransferStore(db);
  const client = new DriveClient({ get: async () => "token", invalidate: () => {} }, drive.fetchFn);
  let now = new Date("2026-11-28T06:00:00Z");
  const uploads = new DriveUploads({ db, client, store, transfersDir, dir: tempDir(), chunkBytes: 4, now: () => now });
  const add = (name: string, data: string) => {
    writeFileSync(join(transfersDir, `${name}.bin`), data);
    return store.add({ origin: "download", sender: "Beelup", name, mediaType: "video/mp4", size: data.length, uploadId: `${name}.bin` }, now);
  };
  const chats = () => (db.prepare("SELECT payload_json AS payload FROM outbox WHERE kind = 'chat_message'").all() as { payload: string }[]).map((row) => (JSON.parse(row.payload) as { text: string }).text);
  const ctx: ToolContext = {
    services: { db, timezone: "America/Argentina/Buenos_Aires", backupRetentionDays: 30, statusSources: [], drive: { client, ready: () => true, uploads } },
    conversationId: "c1",
    turnId: "t1",
    now: () => now,
    security: { tainted: false, taintSources: new Set<string>() },
    emitCard: () => {},
    emitPlayerCommand: () => {},
  };
  const call = (name: string, input: object) => runTool(ctx, toolsByName.get(name as never) as AnyToolDefinition, input);
  return { db, drive, uploads, add, chats, call, transfersDir, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("uploads from Transferencias to Drive", () => {
  it("reads how many bytes Drive already has", () => {
    expect(receivedBytes("bytes=0-1023")).toBe(1024);
    expect(receivedBytes(null)).toBe(0);
  });

  it("uploads a big file in chunks into a folder path it creates, and sends the link without the file name", async () => {
    const env = setup();
    const transfer = env.add("Solares vs Los Pibes", "0123456789");
    const result = await env.call("drive_upload", { transferIds: [transfer.id], folderPath: "Solares/Fecha 3", name: "Solares vs Los Pibes - Fecha 3.mp4" });
    expect(result).toMatchObject({ ok: true, items: [{ name: "Solares vs Los Pibes - Fecha 3.mp4" }] });
    await env.uploads.idle();

    const solares = [...env.drive.files.values()].find((file) => file.name === "Solares");
    const fecha = [...env.drive.files.values()].find((file) => file.name === "Fecha 3");
    expect(solares?.parents).toEqual(["ROOTjarvis00"]);
    expect(fecha?.parents).toEqual([solares?.id]);
    const uploaded = [...env.drive.files.values()].find((file) => file.name === "Solares vs Los Pibes - Fecha 3.mp4");
    expect(uploaded?.parents).toEqual([fecha?.id]);
    expect(uploaded?.data?.toString()).toBe("0123456789");
    expect(env.drive.putCount()).toBe(4);
    const [text] = env.chats();
    expect(text).toContain("https://drive.example/file/");
    expect(text).toContain("Solares/Fecha 3");
    expect(text).not.toContain("Los Pibes");
    expect(await env.call("drive_upload_status", {})).toMatchObject({ ok: true, items: [{ status: "done", progress: 1, duplicate: false }] });
  });

  it("resumes where a dropped connection left it, and keeps the file after the transfer expires", async () => {
    const env = setup(fakeDrive({ dropAt: 3 }));
    const transfer = env.add("partido", "abcdefghij");
    const queued = env.uploads.enqueue({ account: "personal", transferId: transfer.id });
    await env.uploads.idle();
    expect(env.uploads.get(queued!.id)).toMatchObject({ status: "queued", retryAt: "2026-11-28T06:01:00.000Z" });
    rmSync(join(env.transfersDir, "partido.bin"));

    env.advance(61_000);
    env.uploads.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await env.uploads.idle();
    const uploaded = [...env.drive.files.values()].find((file) => file.name === "partido");
    expect(uploaded?.data?.toString()).toBe("abcdefghij");
    expect(env.uploads.get(queued!.id)).toMatchObject({ status: "done" });
    await env.uploads.stop();
  });

  it("does not upload the same file twice to the same folder", async () => {
    const env = setup();
    const first = env.add("partido", "same bytes");
    const second = env.add("partido (2)", "same bytes");
    env.uploads.enqueue({ account: "personal", transferId: first.id, folderPath: "Camba" });
    await env.uploads.idle();
    const again = env.uploads.enqueue({ account: "personal", transferId: second.id, folderPath: "Camba" });
    await env.uploads.idle();
    expect(env.uploads.get(again!.id)).toMatchObject({ status: "done", duplicate: true });
    expect([...env.drive.files.values()].filter((file) => file.size === "10")).toHaveLength(1);
    expect(env.chats()[1]).toContain("ya estaba en Drive");
  });

  it("asks for something to upload and reports transfers that are gone", async () => {
    const env = setup();
    expect(await env.call("drive_upload", {})).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await env.call("drive_upload", { transferIds: ["7d3f2a8e-3a7b-4c1e-9a55-0d3f2a8e3a7b"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("keys a file by its size and both ends, so a renamed copy is still recognized", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a"), "hello world");
    writeFileSync(join(dir, "b"), "hello world");
    writeFileSync(join(dir, "c"), "hello there");
    expect(contentKey(join(dir, "a"), 11)).toBe(contentKey(join(dir, "b"), 11));
    expect(contentKey(join(dir, "a"), 11)).not.toBe(contentKey(join(dir, "c"), 11));
    expect(existsSync(join(dir, "a"))).toBe(true);
  });
});
