import type { Card } from "@jarvis/contracts";
import type { VideoTimeline } from "@jarvis/video";
import { lazy, Suspense, useEffect, useState } from "react";

type VideoCardData = Extract<Card, { kind: "video" }>;

const VideoPreview = lazy(() => import("./VideoPreview.js"));
const POLL_MS = 4000;
const WORKING = new Set<VideoCardData["status"]>(["queued", "voice", "render", "verify"]);

const STATUS: Record<VideoCardData["status"], string> = {
  queued: "En cola",
  voice: "Grabando la voz",
  render: "Animando y renderizando",
  verify: "Revisando el resultado",
  ready: "Listo",
  failed: "No se pudo terminar",
  cancelled: "Reemplazado por una versión nueva",
};

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`;
}

async function share(card: VideoCardData): Promise<void> {
  const file = card.files.light ?? card.files.full;
  if (!file) return;
  const blob = await (await fetch(`/api/attachments/${file.attachmentId}`)).blob();
  const shared = new File([blob], `${card.title}.mp4`, { type: "video/mp4" });
  if (navigator.canShare?.({ files: [shared] })) await navigator.share({ files: [shared], title: card.title });
  else window.open(`/api/attachments/${file.attachmentId}`, "_blank", "noopener");
}

/** A video JARVIS is making: live progress, an animated preview while it renders, then the real MP4 to watch, download or share. */
export function VideoCard({ card: initial }: { card: VideoCardData }) {
  const [card, setCard] = useState(initial);
  const [timeline, setTimeline] = useState<VideoTimeline | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const working = WORKING.has(card.status);

  useEffect(() => setCard(initial), [initial]);

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      fetch(`/api/videos/${card.videoId}`)
        .then((response) => (response.ok ? (response.json() as Promise<VideoCardData>) : undefined))
        .then((next) => next && next.version === card.version && setCard(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [working, card.videoId, card.version]);

  const openPreview = () => {
    setPreviewing(true);
    fetch(`/api/videos/${card.videoId}/v/${card.version}/timeline`)
      .then((response) => (response.ok ? (response.json() as Promise<VideoTimeline>) : null))
      .then(setTimeline)
      .catch(() => setTimeline(null));
  };

  const { full, light, thumbnail, srt } = card.files;
  const vertical = card.format === "vertical";
  return (
    <section className="card card-video" aria-label="Video">
      <p className="card-kicker">Video · versión {card.version}</p>
      <h3 className="card-title">{card.title}</h3>
      <p className="card-status" data-status={card.status} role="status">
        {STATUS[card.status]}
        {card.status === "ready" && card.durationMs ? ` · ${duration(card.durationMs)}` : ""}
        {working ? ` · ${Math.round(card.progress * 100)} %` : ""}
      </p>
      {working && (
        <div className="video-progress" aria-hidden="true">
          <div style={{ width: `${Math.max(4, card.progress * 100)}%` }} />
        </div>
      )}
      {card.error && card.status === "failed" && <p className="card-meta">{card.error}</p>}
      {card.status === "ready" && full ? (
        <video
          className="video-player"
          data-vertical={vertical}
          src={`/api/videos/${card.videoId}/v/${card.version}/watch`}
          poster={thumbnail ? `/api/attachments/${thumbnail}` : undefined}
          controls
          playsInline
          preload="metadata"
        />
      ) : previewing ? (
        <div className="video-player" data-vertical={vertical}>
          {timeline ? (
            <Suspense fallback={<p className="card-meta">Cargando vista previa…</p>}>
              <VideoPreview timeline={timeline} />
            </Suspense>
          ) : (
            <p className="card-meta">Cargando vista previa…</p>
          )}
        </div>
      ) : null}
      <div className="card-actions">
        {working && !previewing && (card.status === "render" || card.status === "verify") && (
          <button type="button" className="button" onClick={openPreview}>
            Ver vista previa
          </button>
        )}
        {card.status === "ready" && full && (
          <>
            <button type="button" className="button primary" onClick={() => void share(card).catch(() => undefined)}>
              Compartir
            </button>
            <a className="button" href={`/api/attachments/${full.attachmentId}`} download>
              Bajar ({megabytes(full.size)})
            </a>
            {light && (
              <a className="button quiet" href={`/api/attachments/${light.attachmentId}`} download>
                Liviano ({megabytes(light.size)})
              </a>
            )}
            {srt && (
              <a className="button quiet" href={`/api/attachments/${srt}`} download>
                Subtítulos
              </a>
            )}
          </>
        )}
      </div>
    </section>
  );
}
