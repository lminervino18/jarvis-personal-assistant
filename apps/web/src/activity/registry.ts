import type { ToolName } from "@jarvis/contracts";

export type ToolCategory = "web" | "mail" | "messaging" | "files" | "media" | "agenda" | "memory" | "tasks" | "system";

export type GlyphName = "globe" | "video" | "image" | "document" | "calendar" | "bell" | "memory" | "person" | "bolt" | "chart" | "transfer" | "gear";

/** A local logo under `public/logos` (a PNG) or a drawn glyph. Nothing is fetched from third parties. */
export type Visual = { kind: "logo"; name: string } | { kind: "glyph"; name: GlyphName };

export interface Integration {
  name: string;
  category: ToolCategory;
  visual: Visual;
}

/**
 * Every integration a tool can belong to. Adding a logo means putting `<name>.png` in
 * `public/logos` and pointing a visual at it.
 */
export const integrations = {
  memory: { name: "la memoria", category: "memory", visual: { kind: "glyph", name: "memory" } },
  contacts: { name: "Contactos", category: "memory", visual: { kind: "glyph", name: "person" } },
  gmail: { name: "Gmail", category: "mail", visual: { kind: "logo", name: "gmail" } },
  whatsapp: { name: "WhatsApp", category: "messaging", visual: { kind: "logo", name: "whatsapp" } },
  calendar: { name: "la agenda", category: "agenda", visual: { kind: "glyph", name: "calendar" } },
  agreements: { name: "Acuerdos", category: "agenda", visual: { kind: "glyph", name: "document" } },
  reminders: { name: "Recordatorios", category: "agenda", visual: { kind: "glyph", name: "bell" } },
  youtube: { name: "YouTube", category: "media", visual: { kind: "glyph", name: "video" } },
  drive: { name: "Google Drive", category: "files", visual: { kind: "logo", name: "drive" } },
  transfers: { name: "Transferencias", category: "files", visual: { kind: "glyph", name: "transfer" } },
  files: { name: "Archivos", category: "files", visual: { kind: "glyph", name: "document" } },
  pages: { name: "Páginas", category: "web", visual: { kind: "glyph", name: "globe" } },
  videos: { name: "Videos", category: "media", visual: { kind: "glyph", name: "video" } },
  images: { name: "Imágenes", category: "media", visual: { kind: "glyph", name: "image" } },
  display: { name: "la vista", category: "system", visual: { kind: "glyph", name: "chart" } },
  tasks: { name: "Tareas", category: "tasks", visual: { kind: "glyph", name: "bolt" } },
  system: { name: "Jarvis", category: "system", visual: { kind: "glyph", name: "gear" } },
  web: { name: "la web", category: "web", visual: { kind: "glyph", name: "globe" } },
  other: { name: "una herramienta", category: "system", visual: { kind: "glyph", name: "bolt" } },
} as const satisfies Record<string, Integration>;

export type IntegrationId = keyof typeof integrations;

/**
 * How one tool shows up while it works. `running` says what is happening, `done` what was achieved
 * (for work that continues in the background, that it started). Neither carries arguments or content.
 */
export interface ToolPresentation {
  integration: IntegrationId;
  running: string;
  done: string;
}

const t = (integration: IntegrationId, running: string, done: string): ToolPresentation => ({ integration, running, done });

/**
 * The presentation of every tool the assistant owns. It is typed on the contract's tool names, so a
 * new tool without an entry does not compile, and `registry.test.ts` checks it again at runtime.
 */
export const toolPresentations: Record<ToolName, ToolPresentation> = {
  memory_search: t("memory", "Buscando en la memoria…", "Memoria consultada"),
  memory_update: t("memory", "Guardando en la memoria…", "Memoria actualizada"),
  memory_forget: t("memory", "Olvidando un recuerdo…", "Recuerdo olvidado"),
  contacts_resolve: t("contacts", "Buscando un contacto…", "Contactos consultados"),
  gmail_search: t("gmail", "Buscando en Gmail…", "Gmail consultado"),
  gmail_get_thread: t("gmail", "Leyendo un correo…", "Correo leído"),
  gmail_send: t("gmail", "Enviando el correo…", "Correo enviado"),
  whatsapp_search: t("whatsapp", "Buscando en WhatsApp…", "WhatsApp consultado"),
  whatsapp_get_messages: t("whatsapp", "Leyendo mensajes de WhatsApp…", "Mensajes leídos"),
  whatsapp_send: t("whatsapp", "Enviando por WhatsApp…", "Mensaje enviado"),
  whatsapp_voice_note: t("whatsapp", "Preparando la nota de voz…", "Nota de voz enviada"),
  whatsapp_to_me: t("whatsapp", "Enviándote por WhatsApp…", "Enviado a tu WhatsApp"),
  whatsapp_study: t("whatsapp", "Preparando el análisis de chats…", "Análisis iniciado"),
  whatsapp_study_result: t("whatsapp", "Leyendo el análisis de chats…", "Análisis leído"),
  whatsapp_get_file: t("whatsapp", "Obteniendo un archivo de WhatsApp…", "Archivo obtenido"),
  calendar_list: t("calendar", "Mirando tu agenda…", "Agenda consultada"),
  calendar_create: t("calendar", "Creando el evento…", "Evento creado"),
  calendar_update: t("calendar", "Actualizando el evento…", "Evento actualizado"),
  agreements_list: t("agreements", "Revisando acuerdos…", "Acuerdos consultados"),
  agreements_propose: t("agreements", "Registrando un acuerdo…", "Acuerdo registrado"),
  agreements_confirm: t("agreements", "Confirmando un acuerdo…", "Acuerdo confirmado"),
  agreements_cancel: t("agreements", "Cancelando un acuerdo…", "Acuerdo cancelado"),
  reminders_create: t("reminders", "Creando el recordatorio…", "Recordatorio creado"),
  reminders_list: t("reminders", "Revisando recordatorios…", "Recordatorios consultados"),
  reminders_update: t("reminders", "Actualizando el recordatorio…", "Recordatorio actualizado"),
  reminders_cancel: t("reminders", "Cancelando el recordatorio…", "Recordatorio cancelado"),
  youtube_search: t("youtube", "Buscando en YouTube…", "YouTube consultado"),
  youtube_open: t("youtube", "Abriendo YouTube…", "YouTube abierto"),
  youtube_play: t("youtube", "Reproduciendo el video…", "Reproducción iniciada"),
  youtube_pause: t("youtube", "Pausando el video…", "Video pausado"),
  whatsapp_link_qr: t("whatsapp", "Pidiendo el QR de WhatsApp…", "QR pedido"),
  integrations_status: t("system", "Revisando las conexiones…", "Conexiones revisadas"),
  show_chart: t("display", "Armando el gráfico…", "Gráfico listo"),
  show_table: t("display", "Armando la tabla…", "Tabla lista"),
  task_create: t("tasks", "Creando una tarea en segundo plano…", "Tarea creada"),
  task_projects: t("tasks", "Listando proyectos…", "Proyectos consultados"),
  task_list: t("tasks", "Revisando tus tareas…", "Tareas consultadas"),
  task_status: t("tasks", "Consultando una tarea…", "Tarea consultada"),
  task_result: t("tasks", "Leyendo el resultado de una tarea…", "Resultado leído"),
  task_feedback: t("tasks", "Enviando indicaciones a una tarea…", "Indicaciones enviadas"),
  task_control: t("tasks", "Controlando una tarea…", "Tarea actualizada"),
  file_share_link: t("files", "Creando un enlace al archivo…", "Enlace creado"),
  video_create: t("videos", "Preparando el video…", "Video encargado"),
  video_status: t("videos", "Consultando el video…", "Video consultado"),
  video_revise: t("videos", "Ajustando el video…", "Ajuste encargado"),
  video_send: t("videos", "Enviando el video…", "Video enviado"),
  video_page: t("videos", "Preparando la página del video…", "Página del video lista"),
  page_create: t("pages", "Creando la página…", "Página creada"),
  page_update: t("pages", "Actualizando la página…", "Página actualizada"),
  page_list: t("pages", "Listando tus páginas…", "Páginas consultadas"),
  tricount: t("display", "Haciendo las cuentas…", "Cuentas hechas"),
  page_responses: t("pages", "Leyendo las respuestas de la página…", "Respuestas leídas"),
  drive_search: t("drive", "Buscando en Google Drive…", "Google Drive consultado"),
  drive_create_folder: t("drive", "Creando una carpeta en Drive…", "Carpeta creada"),
  drive_upload: t("drive", "Subiendo a Google Drive…", "Archivo subido"),
  drive_upload_status: t("drive", "Viendo las subidas a Drive…", "Subidas revisadas"),
  drive_update: t("drive", "Actualizando en Google Drive…", "Archivo actualizado"),
  drive_share: t("drive", "Compartiendo desde Google Drive…", "Archivo compartido"),
  drive_download: t("drive", "Descargando de Google Drive…", "Archivo descargado"),
  drive_trash: t("drive", "Moviendo a la papelera de Drive…", "Archivo en la papelera"),
  transfer_list: t("transfers", "Revisando Transferencias…", "Transferencias consultadas"),
  transfer_upload_link: t("transfers", "Creando un enlace para subir…", "Enlace creado"),
  transfer_share_link: t("transfers", "Creando un enlace para compartir…", "Enlace creado"),
  transfer_from_link: t("transfers", "Preparando la descarga…", "Descarga iniciada"),
  transfer_suggest: t("youtube", "Buscando opciones en YouTube…", "Opciones listas"),
  transfer_edit: t("transfers", "Preparando el recorte…", "Recorte en marcha"),
  transfer_convert: t("transfers", "Preparando la conversión…", "Conversión iniciada"),
  transfer_send: t("transfers", "Mandando el archivo…", "Archivo enviado"),
  image_create: t("images", "Generando la imagen…", "Imagen encargada"),
  pdf_create: t("transfers", "Armando el PDF…", "PDF listo"),
};

/** Tools that do not belong to this server but still run in a turn, such as the SDK's own web search. */
export const externalPresentations: Record<string, ToolPresentation> = {
  WebSearch: t("web", "Buscando en la web…", "Búsqueda web lista"),
};

export interface PresentedTool extends ToolPresentation {
  known: boolean;
}

const MAX_NAME_LENGTH = 28;

/** A tool name that is safe and readable on screen: letters, digits and spaces only, never markup or a long string. */
export function sanitizeToolName(name: string): string {
  const words = name
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : "";
}

/** The presentation for any tool name; an unknown one gets a generic icon and its sanitized name. */
export function presentTool(name: string): PresentedTool {
  const known = (toolPresentations as Record<string, ToolPresentation | undefined>)[name] ?? externalPresentations[name];
  if (known) return { ...known, known: true };
  const readable = sanitizeToolName(name);
  return readable
    ? { integration: "other", running: `Usando ${readable}…`, done: `${readable} usada`, known: false }
    : { integration: "other", running: "Procesando tu pedido…", done: "Acción realizada", known: false };
}

const FAILURES: Record<string, (name: string) => string> = {
  not_connected: (name) => `Falta conectar ${name}`,
  auth_expired: (name) => `Hay que reconectar ${name}`,
  revoked: (name) => `Hay que reconectar ${name}`,
  rate_limited: (name) => `${name} limitó los pedidos`,
  upstream_error: (name) => `${name} no respondió`,
  disabled: (name) => `${name} no está disponible`,
  not_found: (name) => `No se encontró lo pedido en ${name}`,
};

export function failureLabel(tool: PresentedTool, errorCode: string | undefined): string {
  const name = integrations[tool.integration].name;
  return (errorCode ? FAILURES[errorCode]?.(name) : undefined) ?? `No se pudo completar con ${name}`;
}

export function waitingLabel(tool: PresentedTool): string {
  return `Esperando la respuesta de ${integrations[tool.integration].name}…`;
}

export function preparingLabel(tool: PresentedTool): string {
  return `Preparando ${integrations[tool.integration].name}…`;
}
