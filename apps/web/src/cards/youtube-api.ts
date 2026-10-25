export interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

export interface YtEvent {
  data: number;
}

export interface YtPlayerConfig {
  videoId: string;
  host: string;
  width: string;
  height: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady(): void;
    onStateChange(event: YtEvent): void;
    onError(): void;
    onAutoplayBlocked(): void;
  };
}

export interface YtNamespace {
  Player: new (element: HTMLElement, config: YtPlayerConfig) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_URL = "https://www.youtube.com/iframe_api";
let loading: Promise<YtNamespace> | null = null;

/** Loads the IFrame Player API once. */
export function loadYouTubeApi(): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YtNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
      else reject(new Error("YouTube API unavailable"));
    };
    const script = document.createElement("script");
    script.src = API_URL;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("YouTube API blocked"));
    };
    document.head.append(script);
  });
  return loading;
}

export type PlayerStatus = "loading" | "ready" | "buffering" | "playing" | "paused" | "ended" | "blocked" | "error";

/** Maps `onStateChange` codes; unstarted and cued mean the video is ready, not playing. */
export function statusFromYtState(code: number): PlayerStatus | null {
  switch (code) {
    case 1:
      return "playing";
    case 2:
      return "paused";
    case 3:
      return "buffering";
    case 0:
      return "ended";
    case 5:
    case -1:
      return "ready";
    default:
      return null;
  }
}

const statusLabels: Record<PlayerStatus, string> = {
  loading: "Cargando el reproductor",
  ready: "Listo para reproducir",
  buffering: "Cargando el video",
  playing: "Reproduciendo",
  paused: "En pausa",
  ended: "Terminó",
  blocked: "El navegador bloqueó la reproducción automática. Tocá reproducir.",
  error: "No se pudo reproducir el video.",
};

export function playerStatusLabel(status: PlayerStatus): string {
  return statusLabels[status];
}
