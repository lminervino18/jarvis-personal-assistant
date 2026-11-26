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

/** A short sting, like the suit booting: the riff starts, the voice comes in right away and the music fades a second after it ends. */
const VOICE_DELAY_MS = 350;
const TAIL_SECONDS = 1;
const FADE_SECONDS = 0.7;
const MIN_SECONDS = 2.5;
const MUSIC_FILE = "music";
/** Bumped when the mix itself changes, so a cached welcome is made again. */
const MIX_VERSION = 2;

/**
 * The greeting the app plays when it opens: a few seconds of JARVIS's voice saying the owner's
 * phrase over the riff of their song, mixed once by ffmpeg and kept until the phrase or the music change.
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
    return createHash("sha256").update(JSON.stringify([MIX_VERSION, settings.phrase, settings.musicStart, musicStamp, this.options.narrator?.voiceId ?? ""])).digest("hex").slice(0, 16);
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
    await this.options.exec(this.options.ffmpeg ?? "ffmpeg", music ? mixArgs(music, settings.musicStart, voice.path, voice.durationMs, target) : ["-hide_banner", "-nostdin", "-y", "-i", voice.path, "-c:a", "libmp3lame", "-q:a", "2", target]);
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

/** How long the welcome lasts: the phrase plus a second of riff, never shorter than two and a half seconds. */
export function welcomeSeconds(voiceMs: number): number {
  return Math.max(MIN_SECONDS, Math.round((VOICE_DELAY_MS + voiceMs) / 100) / 10 + TAIL_SECONDS);
}

/** ffmpeg mixing the song from `start`, the riff, with the voice coming in right after it starts; the song ducks under the voice so every word is clear. */
export function mixArgs(music: string, start: number, voice: string, voiceMs: number, output: string): string[] {
  const length = welcomeSeconds(voiceMs);
  const graph = [
    `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.75,afade=t=out:st=${(length - FADE_SECONDS).toFixed(2)}:d=${FADE_SECONDS}[music]`,
    `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${VOICE_DELAY_MS}|${VOICE_DELAY_MS},volume=1.9,asplit=2[voice][spoken]`,
    "[spoken]apad[key]",
    "[music][key]sidechaincompress=threshold=0.03:ratio=5:attack=15:release=300[ducked]",
    "[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]",
  ].join(";");
  return ["-hide_banner", "-nostdin", "-y", "-ss", String(start), "-t", String(length), "-i", music, "-i", voice, "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", output];
}
