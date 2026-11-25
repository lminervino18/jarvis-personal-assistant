import type { GmailAccountLabel } from "@jarvis/contracts";
import { DriveError, parseDriveLink, type DriveClient, type DriveFile } from "../integrations/drive/drive-client.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";

const SOURCE = { provider: "drive" };
const MAX_FOLDER_FILES = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export interface DriveServices {
  client: DriveClient;
  /** Whether that Google account granted Drive access. */
  ready(label: GmailAccountLabel): boolean;
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
    "Sube a Drive archivos que ya están en el chat (fotos o archivos que mandó el dueño, imágenes que generaste, archivos bajados de WhatsApp con whatsapp_get_file), por su attachmentId. Van a la carpeta Jarvis salvo que indiques otra (id o link).",
  describe: (_ctx, input) => ({ title: "Subir a Drive", summary: `${input.attachmentIds.length} archivo(s)`, details: [] }),
  async execute(ctx, input) {
    const { drive, label, error } = setup(ctx, input.account);
    if (error) return error;
    const attachments = ctx.services.attachments;
    if (!attachments) return fail("disabled", "Los adjuntos no están configurados en el servidor.");
    return run(async () => {
      const parent = await target(drive, label, input.folderId);
      const uploaded = [];
      for (const id of input.attachmentIds) {
        const stored = attachments.read(id);
        if (!stored) return fail("not_found", "No encontré uno de los archivos para subir.");
        uploaded.push(view(await drive.upload(label, { name: stored.attachment.name, mimeType: stored.attachment.mediaType, data: stored.data, parent }), false));
      }
      return ok(SOURCE, uploaded);
    });
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
    "Baja de Drive un archivo o una carpeta entera a partir de su link (por ejemplo uno que le mandaron al dueño) y los deja como adjuntos del chat. Devuelve un attachmentId por archivo: para mandarlos por WhatsApp usá whatsapp_send con cada attachmentId. Los Docs y Slides llegan en PDF y las planillas en Excel.",
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
      const saved = [];
      const skipped = [];
      let total = 0;
      for (const item of files.slice(0, MAX_FOLDER_FILES)) {
        if (Number(item.size ?? 0) > MAX_FILE_BYTES || total + Number(item.size ?? 0) > MAX_TOTAL_BYTES) {
          skipped.push(item.name);
          continue;
        }
        const content = await drive.download(label, item, item.id === file.id ? parsed.resourceKey : undefined);
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

export const driveTools = [driveSearch, driveCreateFolder, driveUpload, driveUpdate, driveShare, driveDownload, driveTrash] as const;
