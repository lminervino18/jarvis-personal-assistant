import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GmailAccountLabel } from "@jarvis/contracts";
import { DriveError, parseDriveLink, type DriveClient, type DriveFile } from "../integrations/drive/drive-client.js";
import type { DriveUploads } from "../integrations/drive/drive-uploads.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";

const SOURCE = { provider: "drive" };
const MAX_FOLDER_FILES = 100;
/** A file that goes to Transferencias instead of the chat may be this big. */
const MAX_TRANSFER_BYTES = 8 * 1024 ** 3;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface DriveServices {
  client: DriveClient;
  /** Whether that Google account granted Drive access. */
  ready(label: GmailAccountLabel): boolean;
  /** Background uploads from Transferencias. */
  uploads?: DriveUploads;
}

function view(file: DriveFile, folder: boolean) {
  return {
    id: file.id,
    name: file.name,
    kind: folder ? "folder" : file.mimeType,
    ...(file.size ? { size: Number(file.size) } : {}),
    ...(file.modifiedTime ? { modified: file.modifiedTime } : {}),
    ...(file.webViewLink ? { link: file.webViewLink } : {}),
    ...(file.owners?.[0]?.displayName ? { owner: file.owners[0].displayName } : {}),
  };
}

function setup(ctx: ToolContext, account: GmailAccountLabel | undefined) {
  const drive = ctx.services.drive;
  const label = account ?? "personal";
  if (!drive) return { error: fail("disabled", "Google Drive no está configurado en el servidor.") };
  if (!drive.ready(label)) return { error: fail("not_connected", "Google Drive no está conectado: hay que reconectar la cuenta de Google en Configuración para darle acceso.") };
  return { drive: drive.client, label };
}

/** A file id from a link or a bare id, or the Jarvis folder when none is given. */
async function target(client: DriveClient, label: GmailAccountLabel, input: string | undefined): Promise<string> {
  if (!input) return (await client.root(label)).id;
  const parsed = parseDriveLink(input);
  if (!parsed) throw new DriveError("rejected", "No reconozco ese link o id de Drive.");
  return parsed.id;
}

async function run<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DriveError) return fail(error.reason === "not_connected" ? "not_connected" : error.reason === "not_found" ? "not_found" : "upstream_error", error.message, error.reason === "unavailable");
    return fail("upstream_error", "Drive no respondió; probá de nuevo en un rato.", true);
  }
}

const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export const driveSearch = defineTool({
  name: "drive_search",
  description:
    "Busca en el Google Drive del dueño por nombre, o lista una carpeta (id o link). Sin nada, lista la carpeta Jarvis, donde guardás lo que el dueño te pide. Devuelve id, nombre, tipo, fecha y link de cada archivo.",
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    return run(async () => {
      const folder = input.query && !input.folderId ? undefined : await target(drive, label, input.folderId);
      const query = folder ? `'${folder}' in parents and trashed = false` : `name contains '${escape(input.query as string)}' and trashed = false`;
      const files = await drive.list(label, query, 50);
      return ok(SOURCE, files.map((file) => view(file, drive.isFolder(file))));
    });
  },
});

export const driveCreateFolder = defineTool({
  name: "drive_create_folder",
  description: "Crea una carpeta en Drive, dentro de la carpeta Jarvis salvo que el dueño indique otra (id o link). Usala para ordenar lo que guardás.",
  describe: (_ctx, input) => ({ title: "Crear carpeta en Drive", summary: input.name, details: [] }),
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    return run(async () => ok(SOURCE, [view(await drive.createFolder(label, input.name, await target(drive, label, input.parentId)), true)]));
  },
});

export const driveUpload = defineTool({
  name: "drive_upload",
  description:
    "Sube a Drive archivos del chat (attachmentIds: fotos o archivos del dueño, imágenes generadas, archivos de WhatsApp) o de Transferencias (transferIds: videos bajados, partidos de Beelup, lo que subió el dueño), de cualquier tamaño. Van a la carpeta Jarvis o a folderId, y dentro a folderPath («Solares/Fecha 3»), creando las carpetas que falten. Lo de Transferencias sube en segundo plano y el dueño recibe el link al terminar; si ya estaba en esa carpeta no se sube de nuevo.",
  describe: (_ctx, input) => {
    const count = (input.attachmentIds?.length ?? 0) + (input.transferIds?.length ?? 0);
    return { title: "Subir a Drive", summary: `${count} archivo(s)${input.folderPath ? ` a ${input.folderPath}` : ""}`, details: input.name ? [{ label: "Nombre", value: input.name }] : [] };
  },
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    const attachmentIds = input.attachmentIds ?? [];
    const transferIds = input.transferIds ?? [];
    if (attachmentIds.length + transferIds.length === 0) return fail("invalid_input", "Indicá qué subir: attachmentIds o transferIds.");
    const single = attachmentIds.length + transferIds.length === 1 ? input.name : undefined;
    const attachments = ctx.services.attachments;
    if (attachmentIds.length > 0 && !attachments) return fail("disabled", "Los adjuntos no están configurados en el servidor.");
    const uploads = ctx.services.drive?.uploads;
    if (transferIds.length > 0 && !uploads) return fail("disabled", "Las subidas desde Transferencias no están configuradas en el servidor.");
    return run(async () => {
      const base = await target(drive, label, input.folderId);
      const parent = input.folderPath ? (await drive.folderAt(label, base, input.folderPath)).id : base;
      const items: Record<string, unknown>[] = [];
      for (const id of attachmentIds) {
        const stored = attachments?.read(id);
        if (!stored) return fail("not_found", "No encontré uno de los archivos del chat para subir.");
        items.push(view(await drive.upload(label, { name: single ?? stored.attachment.name, mimeType: stored.attachment.mediaType, data: stored.data, parent }), false));
      }
      for (const id of transferIds) {
        const queued = uploads?.enqueue({ account: label, transferId: id, folderId: base, ...(input.folderPath ? { folderPath: input.folderPath } : {}), ...(single ? { name: single } : {}) });
        if (!queued) return fail("not_found", "Uno de los archivos ya no está en Transferencias.");
        items.push({ uploadId: queued.id, name: queued.name, size: queued.size, status: queued.status });
      }
      const note = transferIds.length > 0 ? "Lo de Transferencias sube en segundo plano: cuando termine, el dueño recibe el link. Con drive_upload_status se ve cómo va." : undefined;
      return ok(SOURCE, items, note ? { note } : undefined);
    });
  },
});

export const driveUploadStatus = defineTool({
  name: "drive_upload_status",
  description: "Cómo van las subidas a Drive desde Transferencias: estado, porcentaje y link de las últimas, o de una por su uploadId.",
  async execute(ctx, input) {
    const uploads = ctx.services.drive?.uploads;
    if (!uploads) return fail("disabled", "Las subidas desde Transferencias no están configuradas en el servidor.");
    const items = input.uploadId ? [uploads.get(input.uploadId)].filter((item) => item !== undefined) : uploads.recent();
    if (input.uploadId && items.length === 0) return fail("not_found", "No encontré esa subida.");
    return ok(SOURCE, items);
  },
});

export const driveUpdate = defineTool({
  name: "drive_update",
  description: "Renombra y/o mueve un archivo o carpeta de Drive (id o link) a otra carpeta (id o link). Usala para ordenar.",
  describe: (_ctx, input) => ({ title: "Cambiar en Drive", summary: input.name ? `Renombrar a «${input.name}»` : "Mover", details: [] }),
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    if (!input.name && !input.folderId) return fail("invalid_input", "Indicá un nombre nuevo o una carpeta de destino.");
    return run(async () => {
      const file = await drive.update(label, await target(drive, label, input.fileId), {
        ...(input.name ? { name: input.name } : {}),
        ...(input.folderId ? { parent: await target(drive, label, input.folderId) } : {}),
      });
      return ok(SOURCE, [view(file, drive.isFolder(file))]);
    });
  },
});

export const driveShare = defineTool({
  name: "drive_share",
  description:
    "Comparte un archivo o carpeta de Drive (id o link): con anyone, cualquiera con el link lo puede ver; con email, esa persona puede verlo (reader) o editarlo (writer). Devuelve el link para mandarlo, por ejemplo por WhatsApp.",
  describe: (_ctx, input) => ({ title: "Compartir en Drive", summary: input.anyone ? "Cualquiera con el link puede verlo" : `Con ${input.email ?? "?"}`, details: [] }),
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    if (!input.anyone && !input.email) return fail("invalid_input", "Indicá anyone o un email para compartir.");
    return run(async () => {
      const id = await target(drive, label, input.fileId);
      const file = await drive.share(label, id, input.anyone ? { anyone: true } : { email: input.email as string, role: input.role ?? "reader" });
      return ok(SOURCE, [view(file, drive.isFolder(file))]);
    });
  },
});

export const driveDownload = defineTool({
  name: "drive_download",
  description:
    "Baja de Drive un archivo o una carpeta entera a partir de su link (por ejemplo uno que le mandaron al dueño). Lo chico queda como adjunto del chat (attachmentId: para mandarlo por WhatsApp usá whatsapp_send); lo grande (más de 50 MB, videos, carpetas pesadas) va a Transferencias en calidad original (transferId: para mandarlo usá transfer_send). Los Docs y Slides llegan en PDF y las planillas en Excel.",
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    const attachments = ctx.services.attachments;
    if (!attachments) return fail("disabled", "Los adjuntos no están configurados en el servidor.");
    const parsed = parseDriveLink(input.link);
    if (!parsed) return fail("invalid_input", "No reconozco ese link de Drive.");
    return run(async () => {
      const file = await drive.get(label, parsed.id, parsed.resourceKey);
      const files = drive.isFolder(file)
        ? (await drive.list(label, `'${file.id}' in parents and trashed = false`, MAX_FOLDER_FILES + 1)).filter((child) => !drive.isFolder(child))
        : [file];
      const saved: Record<string, unknown>[] = [];
      const skipped = [];
      let total = 0;
      const transfers = ctx.services.transfers;
      for (const item of files.slice(0, MAX_FOLDER_FILES)) {
        const size = Number(item.size ?? 0);
        const resourceKey = item.id === file.id ? parsed.resourceKey : undefined;
        const big = size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES;
        if (big && transfers?.dir && size <= MAX_TRANSFER_BYTES && !item.mimeType.startsWith("application/vnd.google-apps.")) {
          const uploadId = randomUUID();
          const path = join(transfers.dir, uploadId);
          try {
            await drive.downloadTo(label, item, path, resourceKey);
          } catch (error) {
            rmSync(path, { force: true });
            throw error;
          }
          const kept = transfers.store.add({ origin: "download", sender: "Google Drive", name: item.name, mediaType: item.mimeType || "application/octet-stream", size: statSync(path).size, uploadId }, ctx.now());
          saved.push({ transferId: kept.id, name: kept.name, mediaType: kept.mediaType, size: kept.size, where: "Transferencias" });
          continue;
        }
        if (big) {
          skipped.push(item.name);
          continue;
        }
        const content = await drive.download(label, item, resourceKey);
        const stored = attachments.save({ name: content.name, mediaType: content.mimeType, data: content.data }, ctx.now(), MAX_FILE_BYTES);
        if (!stored) {
          skipped.push(item.name);
          continue;
        }
        total += stored.size;
        saved.push({ attachmentId: stored.id, name: stored.name, mediaType: stored.mediaType, size: stored.size });
      }
      const more = files.length > MAX_FOLDER_FILES ? ` La carpeta tiene más de ${MAX_FOLDER_FILES} archivos: bajé los primeros.` : "";
      const left = skipped.length ? ` No bajé por tamaño: ${skipped.join(", ")}.` : "";
      return ok(SOURCE, saved, { note: `Bajé ${saved.length} archivo(s) de «${file.name}».${more}${left}` });
    });
  },
});

export const driveTrash = defineTool({
  name: "drive_trash",
  description: "Manda a la papelera de Drive un archivo o carpeta (id o link). Se puede recuperar desde la papelera durante 30 días.",
  describe: (_ctx, input) => ({ title: "Mandar a la papelera de Drive", summary: input.fileId, details: [] }),
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    return run(async () => {
      const file = await drive.trash(label, await target(drive, label, input.fileId));
      return ok(SOURCE, [view(file, drive.isFolder(file))]);
    });
  },
});

export const driveTools = [driveSearch, driveCreateFolder, driveUpload, driveUploadStatus, driveUpdate, driveShare, driveDownload, driveTrash] as const;
