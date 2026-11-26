import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Narrator } from "../videos/narrator.js";
import type { Exec } from "../videos/video-qa.js";

export interface WelcomeSettings {
  enabled: boolean;
  /** What Jarvis says when the app opens. */
  phrase: string;
  /** The music under the voice, as the owner named the file; absent for the voice alone. */
  musicName?: string;
  /** Second of the song where the welcome starts, to land on the riff. */
  musicStart: number;
}

/** Seconds of music in the welcome; the voice comes in after the first riff and the music fades at the end. */
const LENGTH_SECONDS = 12;
const VOICE_DELAY_MS = 1500;
const FADE_SECONDS = 3;
const MUSIC_FILE = "music";

/**
 * The greeting the app plays when it opens: JARVIS's voice saying the owner's phrase over a piece
 * of music they chose, mixed once by ffmpeg and kept until the phrase or the music change.
 */
export class Welcome {
  constructor(
    private readonly options: {
      dir: string;
      ownerName: string;
      /** JARVIS's ElevenLabs voice; without it there is no welcome. */
      narrator?: Narrator;
      exec: Exec;
      ffmpeg?: string;
    },
  ) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  }

  get available(): boolean {
    return Boolean(this.options.narrator);
  }

  settings(): WelcomeSettings {
    const defaults: WelcomeSettings = { enabled: true, phrase: `Bienvenido, ${this.options.ownerName}.`, musicStart: 0 };
    const path = join(this.options.dir, "settings.json");
    if (!existsSync(path)) return defaults;
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<WelcomeSettings>;
    const merged = { ...defaults, ...saved };
    return this.music() ? merged : { enabled: merged.enabled, phrase: merged.phrase, musicStart: merged.musicStart };
  }

  update(patch: Partial<Omit<WelcomeSettings, "musicName">>): WelcomeSettings {
    return this.save({ ...this.settings(), ...patch });
  }

  /** Keeps a copy of a song for the welcome, so it outlives the Transferencias file it came from. */
  setMusic(source: string, name: string): WelcomeSettings {
    this.removeMusic();
    copyFileSync(source, join(this.options.dir, `${MUSIC_FILE}${extname(name).toLowerCase() || ".audio"}`));
    return this.save({ ...this.settings(), musicName: name, musicStart: 0 });
  }

  removeMusic(): WelcomeSettings {
    const current = this.music();
    if (current) rmSync(current, { force: true });
    return this.settings();
  }

  /** Changes whenever what the welcome sounds like changes, so the app fetches the new one. */
  version(): string {
    const settings = this.settings();
    const music = this.music();
    const musicStamp = music ? `${statSync(music).size}:${statSync(music).mtimeMs}` : "";
    return createHash("sha256").update(JSON.stringify([settings.phrase, settings.musicStart, musicStamp, this.options.narrator?.voiceId ?? ""])).digest("hex").slice(0, 16);
  }

  /** The mixed MP3, made on first use; undefined without JARVIS's voice. */
  async audio(): Promise<string | undefined> {
    const narrator = this.options.narrator;
    if (!narrator) return undefined;
    const version = this.version();
    const cacheDir = join(this.options.dir, "cache");
    const target = join(cacheDir, `${version}.mp3`);
    if (existsSync(target)) return target;
    mkdirSync(cacheDir, { recursive: true });
    for (const old of readdirSync(cacheDir)) rmSync(join(cacheDir, old), { force: true });
    const settings = this.settings();
    const voice = await narrator.narrate(settings.phrase);
    const music = this.music();
    await this.options.exec(this.options.ffmpeg ?? "ffmpeg", music ? mixArgs(music, settings.musicStart, voice.path, target) : ["-hide_banner", "-nostdin", "-y", "-i", voice.path, "-c:a", "libmp3lame", "-q:a", "2", target]);
    return target;
  }

  private save(settings: WelcomeSettings): WelcomeSettings {
    writeFileSync(join(this.options.dir, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
    return this.settings();
  }

  private music(): string | undefined {
    const file = readdirSync(this.options.dir).find((name) => name.startsWith(`${MUSIC_FILE}.`));
    return file ? join(this.options.dir, file) : undefined;
  }
}

/** ffmpeg mixing the song from `start` under the voice, which comes in after the first riff. */
export function mixArgs(music: string, start: number, voice: string, output: string): string[] {
  const graph = [
    `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.55,afade=t=in:d=0.3,afade=t=out:st=${LENGTH_SECONDS - FADE_SECONDS}:d=${FADE_SECONDS}[music]`,
    `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${VOICE_DELAY_MS}|${VOICE_DELAY_MS},volume=1.8[voice]`,
    "[music][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]",
  ].join(";");
  return ["-hide_banner", "-nostdin", "-y", "-ss", String(start), "-t", String(LENGTH_SECONDS), "-i", music, "-i", voice, "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", output];
}
