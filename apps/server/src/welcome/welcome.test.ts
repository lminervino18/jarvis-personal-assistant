import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Narrator } from "../videos/narrator.js";
import { mixArgs, Welcome } from "./welcome.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(withVoice = true) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-welcome-"));
  dirs.push(dir);
  const said: string[] = [];
  const runs: string[][] = [];
  const narrator = {
    voiceId: "jarvis",
    narrate: async (text: string) => {
      said.push(text);
      writeFileSync(join(dir, "voice.wav"), "wav");
      return { path: join(dir, "voice.wav") };
    },
  } as unknown as Narrator;
  const exec = async (_command: string, args: string[]) => {
    runs.push(args);
    writeFileSync(args.at(-1) ?? "", "mp3");
    return { stdout: "", stderr: "" };
  };
  const welcome = new Welcome({ dir: join(dir, "welcome"), ownerName: "Loren", exec, ...(withVoice ? { narrator } : {}) });
  return { dir, welcome, said, runs };
}

describe("welcome", () => {
  it("greets the owner by name until they write their own phrase", () => {
    const { welcome } = setup();
    expect(welcome.settings()).toEqual({ enabled: true, phrase: "Bienvenido, Loren.", musicStart: 0 });
    expect(welcome.update({ phrase: "Bienvenido, ingeniero.", musicStart: 4 })).toMatchObject({ phrase: "Bienvenido, ingeniero.", musicStart: 4 });
  });

  it("keeps its own copy of the song, mixes the voice over it once, and remixes when something changes", async () => {
    const env = setup();
    writeFileSync(join(env.dir, "song-upload"), "song");
    expect(env.welcome.setMusic(join(env.dir, "song-upload"), "Back in Black.mp3")).toMatchObject({ musicName: "Back in Black.mp3", musicStart: 0 });
    rmSync(join(env.dir, "song-upload"));
    env.welcome.update({ musicStart: 5 });

    const first = await env.welcome.audio();
    expect(await env.welcome.audio()).toBe(first);
    expect(env.said).toEqual(["Bienvenido, Loren."]);
    expect(env.runs).toHaveLength(1);
    expect(env.runs[0]?.slice(3, 9)).toEqual(["-ss", "5", "-t", "12", "-i", join(env.dir, "welcome", "music.mp3")]);

    const version = env.welcome.version();
    env.welcome.update({ phrase: "Bienvenido, ingeniero." });
    expect(env.welcome.version()).not.toBe(version);
    expect(await env.welcome.audio()).not.toBe(first);
    expect(env.said).toEqual(["Bienvenido, Loren.", "Bienvenido, ingeniero."]);

    expect(env.welcome.removeMusic()).not.toHaveProperty("musicName");
    await env.welcome.audio();
    expect(env.runs.at(-1)).toEqual(["-hide_banner", "-nostdin", "-y", "-i", join(env.dir, "voice.wav"), "-c:a", "libmp3lame", "-q:a", "2", expect.stringMatching(/\.mp3$/)]);
  });

  it("has nothing to play without JARVIS's voice", async () => {
    const { welcome } = setup(false);
    expect(welcome.available).toBe(false);
    expect(await welcome.audio()).toBeUndefined();
  });

  it("brings the voice in after the riff and fades the song out", () => {
    const graph = mixArgs("song.mp3", 3, "voice.wav", "out.mp3").join(" ");
    expect(graph).toContain("adelay=1500|1500");
    expect(graph).toContain("afade=t=out:st=9:d=3");
    expect(graph).toContain("amix=inputs=2:duration=first");
  });
});
