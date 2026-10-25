import type { Card } from "@jarvis/contracts";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../db/database.js";
import { YoutubeService } from "../integrations/youtube/youtube-service.js";
import { loadFixture } from "../integrations/google/test-support.js";
import { toolsByName } from "./index.js";
import { runTool } from "./runner.js";
import type { AnyToolDefinition, PlayerCommand, ToolContext } from "./types.js";

const tool = (name: string) => toolsByName.get(name as never) as AnyToolDefinition;

function setup(apiKey?: string) {
  const youtube = new YoutubeService({
    apiKey,
    fetchFn: async () => new Response(JSON.stringify(loadFixture("youtube/search.json")), { status: 200 }),
  });
  const cards: Card[] = [];
  const commands: PlayerCommand[] = [];
  const ctx: ToolContext = {
    services: {
      db: openMigratedDatabase(":memory:"),
      timezone: "America/Argentina/Buenos_Aires",
      backupRetentionDays: 30,
      statusSources: [youtube],
      youtube,
    },
    conversationId: "conv-1",
    turnId: "turn-1",
    now: () => new Date("2026-10-24T15:00:00Z"),
    security: { tainted: false, taintSources: new Set() },
    emitCard: (card) => cards.push(card),
    emitPlayerCommand: (command) => commands.push(command),
  };
  return { ctx, youtube, cards, commands };
}

describe("youtube tools", () => {
  it("returns videos with the API key and taints the turn", async () => {
    const { ctx, cards } = setup("key.example.test");
    const result = await runTool(ctx, tool("youtube_search"), { query: "tutorial" });
    expect(result.ok && result.items).toHaveLength(2);
    expect(ctx.security.taintSources.has("youtube_search")).toBe(true);
    expect(cards).toEqual([]);
  });

  it("falls back to a link card and says so without an API key", async () => {
    const { ctx, cards } = setup();
    const result = await runTool(ctx, tool("youtube_search"), { query: "tutorial" });
    expect(result.ok && result.note).toContain("No hay clave de la API de YouTube");
    expect(cards).toEqual([expect.objectContaining({ kind: "link", url: "https://www.youtube.com/results?search_query=tutorial" })]);
  });

  it("opens a searched video with its title and only reports the request", async () => {
    const { ctx, cards, commands } = setup("key.example.test");
    await runTool(ctx, tool("youtube_search"), { query: "tutorial" });
    const result = await runTool(ctx, tool("youtube_open"), { videoId: "aaaaaaaaaaa" });

    expect(commands).toEqual([{ requestId: expect.any(String), action: "open", videoId: "aaaaaaaaaaa" }]);
    expect(cards.at(-1)).toMatchObject({
      kind: "youtube",
      videoId: "aaaaaaaaaaa",
      title: "Tutorial sintético & pruebas 'uno'",
      channel: "Canal de Prueba",
      autoplay: true,
    });
    expect(result).toMatchObject({ ok: true, items: [{ action: "open", status: "requested", lastReportedPlayerState: null }] });
    expect(result.ok && result.note).toContain("No afirmes que el video está sonando");
  });

  it("pauses and resumes the video the player last reported", async () => {
    const { ctx, youtube, cards, commands } = setup("key.example.test");
    youtube.onPlayerState({ type: "player.state", requestId: "r1", videoId: "bbbbbbbbbbb", state: "playing" });

    const paused = await runTool(ctx, tool("youtube_pause"), {});
    expect(commands.at(-1)).toMatchObject({ action: "pause", videoId: "bbbbbbbbbbb" });
    expect(paused.ok && paused.items[0]).toMatchObject({ lastReportedPlayerState: { state: "playing", videoId: "bbbbbbbbbbb" } });

    await runTool(ctx, tool("youtube_play"), {});
    expect(commands.at(-1)).toMatchObject({ action: "play", videoId: "bbbbbbbbbbb" });
    expect(cards.at(-1)).toMatchObject({ kind: "youtube", videoId: "bbbbbbbbbbb", autoplay: true });
  });

  it("sends play and pause without a card when no video is known", async () => {
    const { ctx, cards, commands } = setup();
    const result = await runTool(ctx, tool("youtube_play"), {});
    await runTool(ctx, tool("youtube_pause"), {});
    expect(commands.map((command) => command.action)).toEqual(["play", "pause"]);
    expect(commands.every((command) => command.videoId === undefined)).toBe(true);
    expect(cards).toEqual([]);
    expect(result.ok && result.note).toContain("No hay un video conocido");
  });

  it("rejects malformed video ids", async () => {
    const { ctx, commands } = setup();
    expect(await runTool(ctx, tool("youtube_open"), { videoId: "short" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(commands).toEqual([]);
  });
});
