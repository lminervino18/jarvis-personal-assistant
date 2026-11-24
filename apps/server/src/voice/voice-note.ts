import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Narrator } from "../videos/narrator.js";
import type { Exec } from "../videos/video-qa.js";

/** WhatsApp shows audio of this type with `ptt` as a voice note, as if just recorded. */
export const VOICE_NOTE_TYPE = "audio/ogg; codecs=opus";

export interface VoiceNote {
  data: Buffer;
  seconds: number;
}

/** Speaks a text with JARVIS's voice and encodes it the way WhatsApp voice notes are: mono Opus in Ogg. */
export class VoiceNoteMaker {
  constructor(
    private readonly narrator: Pick<Narrator, "narrate">,
    private readonly exec: Exec,
  ) {}

  async make(text: string): Promise<VoiceNote> {
    const narration = await this.narrator.narrate(text);
    const dir = await mkdtemp(join(tmpdir(), "jarvis-voice-note-"));
    try {
      const output = join(dir, "nota.ogg");
      await this.exec("ffmpeg", ["-v", "error", "-y", "-i", narration.path, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", output]);
      return { data: await readFile(output), seconds: Math.max(1, Math.round(narration.durationMs / 1000)) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
