import type { Card } from "@jarvis/contracts";
import { useEffect, useRef, useState } from "react";
import { safeHref } from "../format.js";
import type { PlayerReport } from "../conversation/session.js";
import type { CardActions } from "./actions.js";
import { loadYouTubeApi, playerStatusLabel, statusFromYtState, type PlayerStatus, type YtPlayer } from "./youtube-api.js";

type Youtube = Extract<Card, { kind: "youtube" }>;

const AUTOPLAY_GRACE_MS = 3500;

function reportFor(status: PlayerStatus): PlayerReport | null {
  switch (status) {
    case "ready":
    case "playing":
    case "paused":
    case "ended":
    case "blocked":
    case "error":
      return status;
    default:
      return null;
  }
}

export function YoutubeCard({ card, actions }: { card: Youtube; actions: CardActions }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const [status, setStatus] = useState<PlayerStatus>("loading");
  const href = safeHref(card.url);

  useEffect(() => {
    let disposed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let current: PlayerStatus = "loading";
    const update = (next: PlayerStatus) => {
      if (disposed || next === current) return;
      current = next;
      setStatus(next);
      const report = reportFor(next);
      if (report) actions.reportPlayer(card.requestId, card.videoId, report);
      if (next === "playing" || next === "buffering") clearTimeout(graceTimer);
    };
    const unregister = actions.registerPlayer(card.requestId, {
      play: () => playerRef.current?.playVideo(),
      pause: () => playerRef.current?.pauseVideo(),
    });
    loadYouTubeApi()
      .then((YT) => {
        const host = hostRef.current;
        if (disposed || !host) return;
        const mount = document.createElement("div");
        host.replaceChildren(mount);
        playerRef.current = new YT.Player(mount, {
          videoId: card.videoId,
          host: "https://www.youtube-nocookie.com",
          width: "100%",
          height: "100%",
          playerVars: { autoplay: card.autoplay ? 1 : 0, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              update("ready");
              if (card.autoplay) graceTimer = setTimeout(() => current === "ready" && update("blocked"), AUTOPLAY_GRACE_MS);
            },
            onStateChange: (event) => {
              const next = statusFromYtState(event.data);
              if (next && !(next === "ready" && current === "blocked")) update(next);
            },
            onError: () => update("error"),
            onAutoplayBlocked: () => update("blocked"),
          },
        });
      })
      .catch(() => update("error"));
    return () => {
      disposed = true;
      clearTimeout(graceTimer);
      unregister();
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [card.requestId, card.videoId, card.autoplay, actions]);

  const canPlay = status === "ready" || status === "paused" || status === "blocked" || status === "ended";
  return (
    <section className="card card-youtube" aria-label={`Video: ${card.title}`}>
      <div className="player-frame" ref={hostRef} />
      <h3 className="card-title">{card.title}</h3>
      {card.channel && <p className="card-meta">{card.channel}</p>}
      <p className="card-status" data-status={status} role="status">
        {playerStatusLabel(status)}
      </p>
      <div className="card-actions">
        {canPlay && (
          <button type="button" className="button primary" onClick={() => playerRef.current?.playVideo()}>
            Reproducir
          </button>
        )}
        {status === "playing" && (
          <button type="button" className="button" onClick={() => playerRef.current?.pauseVideo()}>
            Pausar
          </button>
        )}
        {href && (
          <a className="button" href={href} target="_blank" rel="noopener noreferrer">
            Abrir en YouTube
          </a>
        )}
      </div>
    </section>
  );
}
