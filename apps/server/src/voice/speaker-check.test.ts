import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ENROLLMENT_PHRASES, registerEnrollmentRoutes } from "./enrollment-routes.js";
import { SpeakerCheck, type Embedder } from "./speaker-check.js";

const RATE = 16_000;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Speech whose first sample stands for the speaker: the fake embedder points each speaker a different way. */
function speech(speaker: number, seconds = 2): Buffer {
  const pcm = Buffer.alloc(RATE * 2 * seconds);
  pcm.writeInt16LE(speaker * 1000, 0);
  return pcm;
}

const embed: Embedder = async (samples) => {
  const speaker = Math.round((samples[0] as number) * 32.768);
  return Float32Array.from({ length: 4 }, (_, i) => (i === speaker ? 1 : 0.1));
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-"));
  dirs.push(dir);
  return { dir, check: new SpeakerCheck({ voiceprintPath: join(dir, "voiceprint.json"), threshold: 0.6, embed }) };
}

describe("SpeakerCheck", () => {
  it("accepts everyone until the owner enrolls, then tells the owner's voice from others", async () => {
    const { check } = setup();
    expect(check.enrolled()).toBe(false);
    expect(await check.matches(speech(1), RATE)).toBeUndefined();

    await check.enroll([speech(1), speech(1)], RATE);
    expect(check.enrolled()).toBe(true);
    expect(await check.matches(speech(1), RATE)).toMatchObject({ owner: true });
    expect(await check.matches(speech(2), RATE)).toMatchObject({ owner: false });
    expect(await check.matches(speech(2).subarray(0, RATE), RATE)).toBeUndefined();

    check.forget();
    expect(check.enrolled()).toBe(false);
  });
});

describe("voice enrollment routes", () => {
  it("stores one recording per phrase and builds the voiceprint when the last one arrives", async () => {
    const { dir, check } = setup();
    const app = Fastify();
    registerEnrollmentRoutes(app, { requireOwner: () => true }, { dir: join(dir, "enrollment"), speaker: check });
    await app.ready();

    const initial = await app.inject({ method: "GET", url: "/api/voice/enrollment" });
    expect(initial.json()).toMatchObject({ recorded: [], enrolled: false, sampleRate: RATE });
    expect(initial.json().phrases).toHaveLength(ENROLLMENT_PHRASES.length);

    const short = await app.inject({ method: "PUT", url: "/api/voice/enrollment/0", payload: Buffer.alloc(100), headers: { "content-type": "application/octet-stream" } });
    expect(short.statusCode).toBe(400);

    let last;
    for (let index = 0; index < ENROLLMENT_PHRASES.length; index++) {
      last = await app.inject({ method: "PUT", url: `/api/voice/enrollment/${index}`, payload: speech(1), headers: { "content-type": "application/octet-stream" } });
    }
    expect(last?.json()).toMatchObject({ enrolled: true, recorded: ENROLLMENT_PHRASES.map((_, index) => index) });
    expect(await check.matches(speech(3), RATE)).toMatchObject({ owner: false });

    const reset = await app.inject({ method: "DELETE", url: "/api/voice/enrollment" });
    expect(reset.json()).toMatchObject({ recorded: [], enrolled: false });
  });
});
