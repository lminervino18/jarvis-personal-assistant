import type { ToolErrorCode } from "@jarvis/contracts";
import { z } from "zod";
import type { IntegrationStatusItem, IntegrationStatusSource } from "../../tools/types.js";
import type { PlayerState } from "../../ws/client-connection.js";
import { decodeEntities } from "../google/text.js";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const REQUEST_TIMEOUT_MS = 10_000;
const REMEMBERED_VIDEOS = 50;
const DESCRIPTION_CHARS = 200;

export interface YoutubeVideo {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  description: string;
  url: string;
  thumbnailUrl: string;
}

export type YoutubeSearchOutcome = { mode: "api"; videos: YoutubeVideo[] } | { mode: "link"; url: string };

export interface TrackedPlayerState {
  requestId: string;
  videoId: string;
  state: PlayerState["state"];
  reportedAt: string;
}

export class YoutubeError extends Error {
  constructor(
    readonly code: Extract<ToolErrorCode, "rate_limited" | "upstream_error">,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const SearchResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().optional() }),
        snippet: z.object({
          title: z.string(),
          channelTitle: z.string().default(""),
          publishedAt: z.string().default(""),
          description: z.string().default(""),
        }),
      }),
    )
    .default([]),
});

const STATE_LABELS: Record<PlayerState["state"], string> = {
  ready: "listo",
  playing: "reproduciendo",
  paused: "en pausa",
  ended: "terminó",
  blocked: "bloqueado por el navegador",
  error: "con error",
};

export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
export const searchPageUrl = (query: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
const thumbnailUrl = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

function toVideo(item: z.infer<typeof SearchResponse>["items"][number]): YoutubeVideo | undefined {
  const videoId = item.id.videoId;
  if (!videoId) return undefined;
  const description = decodeEntities(item.snippet.description).trim();
  return {
    videoId,
    title: decodeEntities(item.snippet.title).trim(),
    channel: decodeEntities(item.snippet.channelTitle).trim(),
    publishedAt: item.snippet.publishedAt,
    description: description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS).trimEnd()}…` : description,
    url: watchUrl(videoId),
    thumbnailUrl: thumbnailUrl(videoId),
  };
}

export interface YoutubeServiceOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * YouTube search through the Data API v3 (or a plain search link without a key) plus an
 * in-memory record of what the player last reported. The server never sees playback itself.
 */
export class YoutubeService implements IntegrationStatusSource {
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly remembered = new Map<string, Pick<YoutubeVideo, "title" | "channel">>();
  private latestState?: TrackedPlayerState;

  constructor(options: YoutubeServiceOptions = {}) {
    this.apiKey = options.apiKey || undefined;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  readonly onPlayerState = (state: PlayerState): void => {
    this.latestState = { requestId: state.requestId, videoId: state.videoId, state: state.state, reportedAt: this.now().toISOString() };
  };

  playerState(): TrackedPlayerState | undefined {
    return this.latestState;
  }

  describeVideo(videoId: string): Pick<YoutubeVideo, "title" | "channel"> | undefined {
    return this.remembered.get(videoId);
  }

  async search(query: string, maxResults: number): Promise<YoutubeSearchOutcome> {
    if (!this.apiKey) return { mode: "link", url: searchPageUrl(query) };
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      relevanceLanguage: "es",
      q: query,
      maxResults: String(maxResults),
      key: this.apiKey,
    });
    const body = await this.requestSearch(`${SEARCH_URL}?${params.toString()}`);
    const videos = SearchResponse.parse(body).items.map(toVideo).filter((video): video is YoutubeVideo => video !== undefined);
    videos.forEach((video) => this.remember(video));
    return { mode: "api", videos };
  }

  async status(): Promise<IntegrationStatusItem[]> {
    const player = this.playerStatus();
    if (!this.apiKey) {
      return [{ provider: "youtube", status: "needs_action", detail: `Falta YOUTUBE_API_KEY: la búsqueda devuelve solo un enlace a YouTube. ${player}` }];
    }
    return [{ provider: "youtube", status: "connected", detail: `Búsqueda con la API de YouTube. ${player}` }];
  }

  private playerStatus(): string {
    const latest = this.latestState;
    if (!latest) return "Reproductor: sin reportes desde que arrancó el servidor.";
    const seconds = Math.max(0, Math.round((this.now().getTime() - new Date(latest.reportedAt).getTime()) / 1000));
    return `Reproductor: ${STATE_LABELS[latest.state]} (último reporte hace ${seconds} s).`;
  }

  private remember(video: YoutubeVideo): void {
    this.remembered.delete(video.videoId);
    this.remembered.set(video.videoId, { title: video.title, channel: video.channel });
    const oldest = this.remembered.keys().next().value;
    if (this.remembered.size > REMEMBERED_VIDEOS && oldest !== undefined) this.remembered.delete(oldest);
  }

  private async requestSearch(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new YoutubeError("upstream_error", "No se pudo contactar a YouTube.", true);
    }
    if (response.ok) return response.json();
    const error = (await response.json().catch(() => undefined)) as { error?: { errors?: { reason?: string }[] } } | undefined;
    if (error?.error?.errors?.[0]?.reason === "quotaExceeded" || response.status === 429) {
      throw new YoutubeError("rate_limited", "Se agotó la cuota diaria de la API de YouTube.");
    }
    throw new YoutubeError("upstream_error", "YouTube rechazó la consulta (revisá YOUTUBE_API_KEY).", response.status >= 500);
  }
}
