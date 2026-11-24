import { z } from "zod";
import type { VideoBrief, VideoSendRequest } from "@jarvis/contracts";
import { LINK_DAYS } from "../files/file-links.js";
import { WhatsAppReader } from "../integrations/whatsapp/message-reader.js";
import { bridgeConnected } from "../integrations/whatsapp/status.js";
import { deliveryFor, sendVideo } from "../videos/video-delivery.js";
import { videoPageHtml } from "../videos/video-page.js";
import { formatDuration } from "../videos/video-paths.js";
import { repetitionProblem } from "../videos/video-script.js";
import type { VideoSend, VideoStore, VideoVersion } from "../videos/video-store.js";
import { fail, ok } from "./envelope.js";
import { defineTool, type ToolContext } from "./types.js";
import { queryFailure } from "./whatsapp-tools.js";

const SOURCE = { provider: "videos" };
const DISABLED = "Los videos no están configurados en el servidor.";
const CHANNEL_NAME = { whatsapp: "WhatsApp", email: "mail" } as const;

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`;
}

function briefProblem(ctx: ToolContext, brief: VideoBrief): string | undefined {
  return mediaProblem(ctx, brief) ?? repetitionProblem(brief, ctx.services.ownerName ?? "");
}

/** Resolves who a requested send goes to before the video exists, so the card can name them. */
function resolveSend(ctx: ToolContext, request: VideoSendRequest): VideoSend | { problem: ReturnType<typeof fail> } {
  const base = { channel: request.channel, status: "pending" as const, ...(request.text ? { text: request.text } : {}), ...(request.subject ? { subject: request.subject } : {}) };
  if (request.channel === "email") {
    if (!z.email().safeParse(request.to).success) return { problem: fail("invalid_input", "Para mandarlo por mail necesito una dirección válida.") };
    const account = request.account ?? "personal";
    const problem = ctx.services.gmail ? ctx.services.gmail.cannotSend(account) : "Gmail no está configurado en el servidor.";
    if (problem) return { problem: fail("not_connected", problem) };
    return { ...base, to: request.to, recipient: request.to, account };
  }
  try {
    const chat = new WhatsAppReader(ctx.services.db, ctx.services.timezone).resolveChat(request.to, { liveOnly: true });
    return { ...base, to: chat.jid, recipient: chat.name?.trim() || request.to };
  } catch (error) {
    return { problem: queryFailure(error) };
  }
}

function mediaProblem(ctx: ToolContext, brief: VideoBrief): string | undefined {
  for (const scene of brief.scenes) {
    if (scene.type !== "media") continue;
    const attachment = ctx.services.attachments?.get(scene.attachmentId);
    if (!attachment) return "Una escena usa un archivo que no existe: pedile al dueño que lo vuelva a mandar.";
    if (!/^(image|video)\//.test(attachment.mediaType)) return `«${attachment.name}» no es una foto ni un video; usá una escena con diagrama o emojis.`;
  }
  return undefined;
}

function summary(store: VideoStore, version: VideoVersion, baseUrl: string | undefined) {
  const video = store.get(version.videoId);
  const ready = store.latestReady(version.videoId);
  return {
    videoId: version.videoId,
    title: version.brief.title,
    version: version.version,
    status: version.status,
    progress: Math.round(version.progress * 100),
    ...(version.durationMs !== undefined ? { duration: formatDuration(version.durationMs) } : {}),
    ...(version.error ? { error: version.error } : {}),
    ...(ready
      ? {
          readyVersion: ready.version,
          files: {
            ...(ready.files.full ? { full: { attachmentId: ready.files.full.attachmentId, size: megabytes(ready.files.full.size) } } : {}),
            ...(ready.files.light ? { light: { attachmentId: ready.files.light.attachmentId, size: megabytes(ready.files.light.size) } } : {}),
            ...(ready.files.thumbnail ? { thumbnail: ready.files.thumbnail } : {}),
          },
          checks: ready.qa?.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`),
        }
      : {}),
    ...(video?.pageSlug && baseUrl ? { pageUrl: `${baseUrl.replace(/\/+$/, "")}/${video.pageSlug}` } : {}),
    deliveries: store.deliveries(version.videoId).map((item) => ({ version: item.version, channel: item.channel, recipient: item.recipient, file: item.file, status: item.status, at: item.createdAt })),
    brief: version.brief,
  };
}

const RENDER_NOTE =
  "Se arma en segundo plano (voz, animación, render y control de calidad) y tarda unos minutos: el chat avisa cuando está listo. No digas que ya está ni que lo mandaste.";

export const videoCreate = defineTool({
  name: "video_create",
  description:
    "Arma un video narrado con la voz de Jarvis (vertical por defecto), con animaciones, diagramas, emojis y subtítulos, para explicar algo, anunciar, pedir una respuesta o contar un resultado. Escribí el guion vos: para quién es, objetivo, mensaje, datos confirmados (nada inventado), «purpose» que completa «Este mensaje es para …» (la presentación «Hola, soy Jarvis, el asistente personal de …» la agrega el servidor), y las escenas (title, compare, stat, steps, result, question, closing, media con fotos o videos del dueño) con una narración por escena que nombre lo que se ve. Estándar: unos 10 segundos, o sea la presentación más 1 o 2 escenas de una sola oración corta (unos 60 caracteres cada una); más escenas y más largo solo si el dueño lo pide. No repitas: «purpose» es el tema general y cada escena suma algo nuevo (un dato, las opciones, qué hacer), nunca lo mismo con otras palabras; el servidor rechaza escenas que repiten. Si el dueño ya dijo a quién mandarlo («mandale a Juan un video…»), pasalo en sendTo: se lo manda solo apenas está listo, sin video_send.",
  async execute(ctx, input) {
    const store = ctx.services.videos;
    if (!store) return fail("disabled", DISABLED);
    const problem = briefProblem(ctx, input.brief);
    if (problem) return fail("invalid_input", problem);
    const send = input.sendTo ? resolveSend(ctx, input.sendTo) : undefined;
    if (send && "problem" in send) return send.problem;
    const version = store.create(input.brief, ctx.services.ownerName ?? "su dueño", ctx.now(), send);
    const card = store.card(version.videoId);
    if (card) ctx.emitCard(card);
    const sendNote = send ? ` Apenas esté listo se lo manda solo a ${send.recipient}; no llames video_send para este envío.` : "";
    return ok(SOURCE, [{ videoId: version.videoId, version: version.version, status: version.status, ...(send ? { sendTo: send.recipient } : {}) }], { note: RENDER_NOTE + sendNote });
  },
});

export const videoStatus = defineTool({
  name: "video_status",
  description:
    "Estado de un video (avance, duración, archivos, controles de calidad, envíos y el guion actual para corregirlo) o, sin videoId, la lista de los últimos videos.",
  async execute(ctx, input) {
    const store = ctx.services.videos;
    if (!store) return fail("disabled", DISABLED);
    if (!input.videoId) {
      return ok(
        SOURCE,
        store.list(10).map((video) => ({ videoId: video.id, title: video.title, version: video.currentVersion, status: video.status, ...(video.durationMs ? { duration: formatDuration(video.durationMs) } : {}) })),
      );
    }
    const version = store.version(input.videoId);
    if (!version) return fail("not_found", "No encuentro ese video.");
    return ok(SOURCE, [summary(store, version, ctx.services.filesBaseUrl)]);
  },
});

export const videoRevise = defineTool({
  name: "video_revise",
  description:
    "Hace una versión nueva de un video con el guion completo corregido (partí del «brief» de video_status y cambiá solo lo pedido: «más corto», «cambiá la segunda escena», «en horizontal»). La narración de las escenas que no cambian se reutiliza sin volver a generarla. La versión anterior sigue disponible.",
  async execute(ctx, input) {
    const store = ctx.services.videos;
    if (!store) return fail("disabled", DISABLED);
    const problem = briefProblem(ctx, input.brief);
    if (problem) return fail("invalid_input", problem);
    const version = store.revise(input.videoId, input.brief, ctx.now());
    if (!version) return fail("not_found", "No encuentro ese video.");
    const card = store.card(version.videoId);
    if (card) ctx.emitCard(card);
    return ok(SOURCE, [{ videoId: version.videoId, version: version.version, status: version.status }], { note: RENDER_NOTE });
  },
});

function readyVersion(ctx: ToolContext, videoId: string): VideoVersion | string {
  const store = ctx.services.videos;
  if (!store) return DISABLED;
  if (!store.get(videoId)) return "No encuentro ese video.";
  return store.latestReady(videoId) ?? "El video todavía no está listo: esperá el aviso en el chat.";
}

export const videoSend = defineTool({
  name: "video_send",
  description:
    "Manda la última versión lista de un video por WhatsApp (a un chat por id, número o nombre) o por mail, con un texto corto opcional (sin texto si el dueño lo pide así). Elige solo el archivo que entra en el canal (el completo, el liviano o, si no entra, un link de 7 días) y suma el link de la versión interactiva si existe. Se manda directo cuando el dueño dice a quién; «armá un video para mandar» sin destinatario no autoriza el envío.",
  prepare(ctx, input) {
    const version = readyVersion(ctx, input.videoId);
    if (typeof version === "string") return { refused: fail("not_found", version) };
    if (input.channel === "email") {
      if (!z.email().safeParse(input.to).success) return { refused: fail("invalid_input", "Para mandarlo por mail necesito una dirección válida.") };
      const gmail = ctx.services.gmail;
      const account = input.account ?? "personal";
      const problem = gmail ? gmail.cannotSend(account) : "Gmail no está configurado en el servidor.";
      if (problem) return { refused: fail("not_connected", problem) };
      return { input: { ...input, account } };
    }
    try {
      const chat = new WhatsAppReader(ctx.services.db, ctx.services.timezone).resolveChat(input.to, { liveOnly: true });
      if (!bridgeConnected(ctx.services.db, ctx.now())) return { refused: fail("not_connected", "WhatsApp no está conectado ahora: el video no se envió.") };
      return { input: { ...input, to: chat.jid } };
    } catch (error) {
      return { refused: queryFailure(error) };
    }
  },
  replaces: (pending, next) => pending.videoId === next.videoId && pending.channel === next.channel && pending.to === next.to,
  describe(ctx, input) {
    const version = readyVersion(ctx, input.videoId);
    const recipient =
      input.channel === "whatsapp" ? (new WhatsAppReader(ctx.services.db, ctx.services.timezone).resolveChat(input.to, { liveOnly: true }).name?.trim() ?? input.to) : input.to;
    if (typeof version === "string") return { title: "Enviar video", summary: `Para ${recipient}`, details: [{ label: "Mensaje", value: input.text || "Sin texto" }] };
    const delivery = deliveryFor(version, input.channel);
    const file = delivery.file === "link" ? `Link que vence en ${LINK_DAYS} días (el archivo no entra en ${CHANNEL_NAME[input.channel]})` : `${delivery.file === "full" ? "Completo" : "Liviano"}, ${megabytes(delivery.size)}`;
    return {
      title: "Enviar video",
      summary: `Para ${recipient} por ${CHANNEL_NAME[input.channel]}`,
      details: [
        { label: "Video", value: `«${version.brief.title}» · versión ${version.version} · ${formatDuration(version.durationMs ?? 0)}` },
        { label: "Archivo", value: file },
        ...(input.channel === "email" ? [{ label: "Asunto", value: input.subject ?? version.brief.title }] : []),
        { label: "Mensaje", value: input.text || "Sin texto" },
      ],
    };
  },
  async execute(ctx, input) {
    const sent = await sendVideo(ctx.services, input, ctx.now());
    if (!sent.ok) return fail(sent.code, sent.message, sent.retryable);
    const note = sent.repeated
      ? "Ese mismo envío ya se había hecho; no lo repetí."
      : sent.status === "queued"
        ? "Quedó en la cola de WhatsApp y sale en unos segundos. No afirmes que llegó ni que lo vieron."
        : "El mail salió desde Gmail.";
    return ok(SOURCE, [{ deliveryId: sent.deliveryId, file: sent.file, status: sent.status }], { note });
  },
});

export const videoPage = defineTool({
  name: "video_page",
  description:
    "Publica la versión web interactiva de la última versión lista de un video: el video con botones reales para elegir una opción, responder, abrir las fuentes y ver más información. Las respuestas le llegan al dueño. Es pública para quien tenga el link: usala cuando el pedido necesita respuesta o fuentes, o cuando el dueño la pide.",
  describe(ctx, input) {
    const version = readyVersion(ctx, input.videoId);
    return {
      title: "Publicar versión interactiva",
      summary: typeof version === "string" ? "Video" : `«${version.brief.title}»`,
      details: [{ label: "Página", value: "Pública para quien tenga el link" }],
    };
  },
  async execute(ctx, input) {
    const { videos: store, pages, filesBaseUrl } = ctx.services;
    if (!store || !pages || !filesBaseUrl) return fail("disabled", "Las páginas no están configuradas en el servidor.");
    const version = readyVersion(ctx, input.videoId);
    if (typeof version === "string") return fail("not_found", version);
    const full = version.files.full;
    if (!full) return fail("internal", "El video listo no tiene su archivo.");
    const owner = store.get(input.videoId)?.ownerName ?? "";
    const assets = [full.attachmentId, ...(version.files.thumbnail ? [version.files.thumbnail] : [])];
    const page = pages.publishStatic({
      title: version.brief.title,
      brief: `Versión interactiva del video «${version.brief.title}» (versión ${version.version}).`,
      attachmentIds: assets,
      html: (slug) =>
        videoPageHtml(version, owner, {
          video: `/${slug}/f/${full.attachmentId}`,
          ...(version.files.thumbnail ? { poster: `/${slug}/f/${version.files.thumbnail}` } : {}),
        }),
    });
    store.setPageSlug(input.videoId, page.slug, ctx.now());
    const url = `${filesBaseUrl.replace(/\/+$/, "")}/${page.slug}`;
    ctx.emitCard({ kind: "link", url, title: version.brief.title, description: "Versión interactiva del video" });
    return ok(SOURCE, [{ url, version: version.version }], { note: "video_send suma este link solo; las respuestas te llegan como respuestas de la página." });
  },
});

export const videoTools = [videoCreate, videoStatus, videoRevise, videoSend, videoPage] as const;
