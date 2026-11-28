import type { GmailAccountLabel } from "@jarvis/contracts";
import type { GoogleAccessTokens } from "../google/access-tokens.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,parents,owners(displayName)";
const FOLDER = "application/vnd.google-apps.folder";
const TIMEOUT_MS = 60_000;
/** Marks the folder JARVIS works in, so it is found again even if the owner renames it. */
const ROOT_PROPERTY = "jarvisRoot";

/** Google files have no bytes of their own: they are exported to a common format to download. */
const EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: "pdf" },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: "pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "application/pdf", extension: "pdf" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" },
};

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  owners?: { displayName?: string }[];
}

export type DriveFailure = "not_found" | "forbidden" | "not_connected" | "unavailable" | "rejected";

/** A failed Drive call, in a sentence the owner can act on. Never carries tokens or response bodies. */
export class DriveError extends Error {
  constructor(
    readonly reason: DriveFailure,
    message: string,
  ) {
    super(message);
  }
}

function failure(status: number): DriveError {
  if (status === 404) return new DriveError("not_found", "No encontré ese archivo en Drive, o la cuenta no tiene acceso.");
  if (status === 403) return new DriveError("forbidden", "Drive no permite esa operación con ese archivo.");
  if (status === 401) return new DriveError("not_connected", "Hay que reconectar Google en Configuración para darle acceso a Drive.");
  if (status >= 500) return new DriveError("unavailable", "Drive no respondió; probá de nuevo en un rato.");
  return new DriveError("rejected", "Drive rechazó el pedido.");
}

/** The id (and resource key, for old shared links) inside a Drive or Docs link, or a bare id. */
export function parseDriveLink(input: string): { id: string; resourceKey?: string } | undefined {
  const text = input.trim();
  const url = (() => {
    try {
      return new URL(text);
    } catch {
      return undefined;
    }
  })();
  if (!url) return /^[\w-]{10,}$/.test(text) ? { id: text } : undefined;
  if (!/(^|\.)google\.com$/.test(url.hostname)) return undefined;
  const id = url.pathname.match(/\/(?:d|folders)\/([\w-]{10,})/)?.[1] ?? url.searchParams.get("id") ?? undefined;
  if (!id || !/^[\w-]{10,}$/.test(id)) return undefined;
  const resourceKey = url.searchParams.get("resourcekey") ?? undefined;
  return { id, ...(resourceKey ? { resourceKey } : {}) };
}

/** Where a resumable upload stands: finished with its file, or how many bytes Drive already has. */
export type ResumableState = { done: DriveFile } | { received: number };

/** The bytes Drive confirmed in a 308 answer's Range header (`bytes=0-N`), 0 when it has none. */
export function receivedBytes(range: string | null): number {
  const end = range?.match(/bytes=0-(\d+)/)?.[1];
  return end === undefined ? 0 : Number(end) + 1;
}

const escapeQuery = (text: string) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Drive v3 over `fetch`, with the owner's Google account tokens. */
export class DriveClient {
  constructor(
    private readonly tokens: Pick<GoogleAccessTokens, "get" | "invalidate">,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  isFolder(file: DriveFile): boolean {
    return file.mimeType === FOLDER;
  }

  /** The folder JARVIS keeps its things in, created at the root of My Drive the first time. */
  async root(label: GmailAccountLabel): Promise<DriveFile> {
    const query = `appProperties has { key='${ROOT_PROPERTY}' and value='true' } and trashed = false`;
    const found = await this.list(label, query, 1);
    if (found[0]) return found[0];
    return this.json(label, `${API}?fields=${FIELDS}`, "POST", { name: "Jarvis", mimeType: FOLDER, appProperties: { [ROOT_PROPERTY]: "true" } });
  }

  async list(label: GmailAccountLabel, query: string, limit = 50): Promise<DriveFile[]> {
    const params = new URLSearchParams({ q: query, fields: `files(${FIELDS})`, pageSize: String(limit), orderBy: "folder,modifiedTime desc", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const result = await this.json<{ files: DriveFile[] }>(label, `${API}?${params.toString()}`);
    return result.files;
  }

  async get(label: GmailAccountLabel, id: string, resourceKey?: string): Promise<DriveFile> {
    return this.json(label, `${API}/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`, "GET", undefined, resourceKey ? { "X-Goog-Drive-Resource-Keys": `${id}/${resourceKey}` } : {});
  }

  async createFolder(label: GmailAccountLabel, name: string, parent: string): Promise<DriveFile> {
    return this.json(label, `${API}?fields=${FIELDS}&supportsAllDrives=true`, "POST", { name, mimeType: FOLDER, parents: [parent] });
  }

  /** The folder at `path` («Solares/Fecha 3») under `parent`, creating whatever part is missing. */
  async folderAt(label: GmailAccountLabel, parent: string, path: string): Promise<DriveFile> {
    let current = await this.get(label, parent);
    for (const name of path.split("/").map((part) => part.trim()).filter(Boolean)) {
      const query = `'${current.id}' in parents and name = '${escapeQuery(name)}' and mimeType = '${FOLDER}' and trashed = false`;
      current = (await this.list(label, query, 1))[0] ?? (await this.createFolder(label, name, current.id));
    }
    return current;
  }

  /** A file in `parent` that JARVIS uploaded with this content key, so the same file is not uploaded twice. */
  async findUploaded(label: GmailAccountLabel, parent: string, key: string): Promise<DriveFile | undefined> {
    const query = `'${parent}' in parents and appProperties has { key='jarvisKey' and value='${escapeQuery(key)}' } and trashed = false`;
    return (await this.list(label, query, 1))[0];
  }

  /** Opens a resumable upload and returns its session address, valid for about a week. */
  async startResumable(label: GmailAccountLabel, input: { name: string; mimeType: string; size: number; parent: string; key: string }): Promise<string> {
    const response = await this.send(label, `${UPLOAD}?uploadType=resumable&fields=${FIELDS}&supportsAllDrives=true`, "POST", { name: input.name, parents: [input.parent], appProperties: { jarvisKey: input.key } }, {
      "x-upload-content-type": input.mimeType,
      "x-upload-content-length": String(input.size),
    });
    const session = response.headers.get("location");
    if (!session) throw new DriveError("unavailable", "Drive no abrió la subida; probá de nuevo en un rato.");
    return session;
  }

  /** Sends bytes `start` to `start + chunk.length` of a `total`-byte resumable upload; an empty chunk only asks where it stands. */
  async sendChunk(label: GmailAccountLabel, session: string, chunk: Buffer, start: number, total: number): Promise<ResumableState> {
    const range = chunk.length === 0 ? `bytes */${total}` : `bytes ${start}-${start + chunk.length - 1}/${total}`;
    const call = async () =>
      this.fetchFn(session, {
        method: "PUT",
        headers: { authorization: `Bearer ${await this.tokens.get(label)}`, "content-range": range },
        body: new Uint8Array(chunk),
        signal: AbortSignal.timeout(10 * TIMEOUT_MS),
      });
    let response: Response;
    try {
      response = await call();
      if (response.status === 401) {
        this.tokens.invalidate(label);
        response = await call();
      }
    } catch {
      throw new DriveError("unavailable", "Drive no respondió; probá de nuevo en un rato.");
    }
    if (response.status === 308) return { received: receivedBytes(response.headers.get("range")) };
    if (!response.ok) throw failure(response.status);
    return { done: (await response.json()) as DriveFile };
  }

  async upload(label: GmailAccountLabel, input: { name: string; mimeType: string; data: Buffer; parent: string }): Promise<DriveFile> {
    const boundary = `jarvis-${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name: input.name, parents: [input.parent] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      input.data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.json(label, `${UPLOAD}?uploadType=multipart&fields=${FIELDS}&supportsAllDrives=true`, "POST", body, { "content-type": `multipart/related; boundary=${boundary}` });
  }

  /** Renames and/or moves a file; moving replaces all its parents with the new folder. */
  async update(label: GmailAccountLabel, id: string, change: { name?: string; parent?: string }): Promise<DriveFile> {
    const params = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" });
    if (change.parent) {
      const current = await this.get(label, id);
      params.set("addParents", change.parent);
      if (current.parents?.length) params.set("removeParents", current.parents.join(","));
    }
    return this.json(label, `${API}/${encodeURIComponent(id)}?${params.toString()}`, "PATCH", change.name ? { name: change.name } : {});
  }

  /** Anyone with the link can view, or one person by email can view or edit. Returns the file's link. */
  async share(label: GmailAccountLabel, id: string, access: { anyone: true } | { email: string; role: "reader" | "writer" }): Promise<DriveFile> {
    const permission = "anyone" in access ? { type: "anyone", role: "reader" } : { type: "user", role: access.role, emailAddress: access.email };
    await this.json(label, `${API}/${encodeURIComponent(id)}/permissions?supportsAllDrives=true&sendNotificationEmail=${"anyone" in access ? "false" : "true"}`, "POST", permission);
    return this.get(label, id);
  }

  async trash(label: GmailAccountLabel, id: string): Promise<DriveFile> {
    return this.json(label, `${API}/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`, "PATCH", { trashed: true });
  }

  /** The bytes of a file; Google Docs, Sheets and Slides come exported to PDF or Excel. */
  async download(label: GmailAccountLabel, file: DriveFile, resourceKey?: string): Promise<{ name: string; mimeType: string; data: Buffer }> {
    const exported = EXPORTS[file.mimeType];
    if (file.mimeType.startsWith("application/vnd.google-apps.") && !exported) throw new DriveError("rejected", `«${file.name}» es un tipo de archivo de Google que no se puede descargar.`);
    const url = exported
      ? `${API}/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
      : `${API}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    const response = await this.send(label, url, "GET", undefined, resourceKey ? { "X-Goog-Drive-Resource-Keys": `${file.id}/${resourceKey}` } : {});
    const data = Buffer.from(await response.arrayBuffer());
    return exported ? { name: `${file.name}.${exported.extension}`, mimeType: exported.mimeType, data } : { name: file.name, mimeType: file.mimeType, data };
  }

  private async json<T = DriveFile>(label: GmailAccountLabel, url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.send(label, url, method, body, headers);
    return (await response.json()) as T;
  }

  private async send(label: GmailAccountLabel, url: string, method: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const attempt = async () => {
      const init: RequestInit = { method, headers: { authorization: `Bearer ${await this.tokens.get(label)}`, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (body !== undefined) {
        init.body = Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body);
        if (!Buffer.isBuffer(body)) init.headers = { ...init.headers, "content-type": "application/json" };
      }
      try {
        return await this.fetchFn(url, init);
      } catch {
        throw new DriveError("unavailable", "Drive no respondió; probá de nuevo en un rato.");
      }
    };
    let response = await attempt();
    if (response.status === 401) {
      this.tokens.invalidate(label);
      response = await attempt();
    }
    if (!response.ok) throw failure(response.status);
    return response;
  }
}
