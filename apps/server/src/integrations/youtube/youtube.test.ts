import { describe, expect, it } from "vitest";
import { loadFixture } from "../google/test-support.js";
import { YoutubeService } from "./youtube-service.js";

function fakeFetch(status = 200, body: unknown = loadFixture("youtube/search.json")) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, urls };
}

describe("YoutubeService", () => {
  it("searches embeddable videos, skips non-videos and decodes titles", async () => {
    const { fetchFn, urls } = fakeFetch();
    const service = new YoutubeService({ apiKey: "key.example.test", fetchFn });
    const outcome = await service.search("tutorial", 3);

    expect(outcome.mode).toBe("api");
    if (outcome.mode !== "api") return;
    expect(outcome.videos.map((video) => video.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(outcome.videos[0]).toMatchObject({
      title: "Tutorial sintético & pruebas 'uno'",
      channel: "Canal de Prueba",
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg",
    });
    expect(outcome.videos[1]?.description.length).toBeLessThanOrEqual(201);
    const url = new URL(urls[0] as string);
    expect(url.searchParams.get("videoEmbeddable")).toBe("true");
    expect(url.searchParams.get("maxResults")).toBe("3");
    expect(service.describeVideo("bbbbbbbbbbb")).toEqual({ title: "Segundo video de prueba", channel: "Otro Canal" });
  });

  it("returns a search link and never calls the network without a key", async () => {
    const { fetchFn, urls } = fakeFetch();
    const outcome = await new YoutubeService({ fetchFn }).search("música tranquila", 3);
    expect(outcome).toEqual({ mode: "link", url: "https://www.youtube.com/results?search_query=m%C3%BAsica%20tranquila" });
    expect(urls).toEqual([]);
  });

  it("maps quota exhaustion and other failures without leaking the key", async () => {
    const quota = fakeFetch(403, { error: { errors: [{ reason: "quotaExceeded" }] } });
    await expect(new YoutubeService({ apiKey: "key.example.test", fetchFn: quota.fetchFn }).search("x", 3)).rejects.toMatchObject({
      code: "rate_limited",
    });

    const broken = fakeFetch(500, {});
    const error = await new YoutubeService({ apiKey: "key.example.test", fetchFn: broken.fetchFn }).search("x", 3).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "upstream_error", retryable: true });
    expect((error as Error).message).not.toContain("key.example.test");
  });

  it("tracks the latest player report and reports it in status", async () => {
    let clock = new Date("2026-10-24T15:00:00Z");
    const service = new YoutubeService({ apiKey: "key.example.test", now: () => clock });
    expect((await service.status())[0]?.detail).toContain("sin reportes");

    service.onPlayerState({ type: "player.state", requestId: "r1", videoId: "aaaaaaaaaaa", state: "playing" });
    clock = new Date("2026-10-24T15:00:30Z");
    expect(service.playerState()).toEqual({ requestId: "r1", videoId: "aaaaaaaaaaa", state: "playing", reportedAt: "2026-10-24T15:00:00.000Z" });
    expect(await service.status()).toEqual([
      { provider: "youtube", status: "connected", detail: "Búsqueda con la API de YouTube. Reproductor: reproduciendo (último reporte hace 30 s)." },
    ]);
  });

  it("asks for the API key in status when it is missing", async () => {
    const [item] = await new YoutubeService().status();
    expect(item).toMatchObject({ provider: "youtube", status: "needs_action" });
    expect(item?.detail).toContain("YOUTUBE_API_KEY");
  });
});
