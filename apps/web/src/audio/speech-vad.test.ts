import { describe, expect, it } from "vitest";
import { SpeechVad, speechVadOptions } from "./speech-vad.js";

function run(vad: SpeechVad, probability: number, ms: number): string[] {
  const decisions: string[] = [];
  for (let t = 0; t < ms; t += speechVadOptions.frameMs) decisions.push(vad.push(probability));
  return decisions.filter((decision) => decision !== "idle" && decision !== "pending" && decision !== "speech");
}

describe("SpeechVad", () => {
  it("starts after enough voiced time and reports a pause after 450 ms of silence", () => {
    const vad = new SpeechVad();
    expect(run(vad, 0.9, 200)).toEqual(["start"]);
    expect(run(vad, 0.1, 440)).toEqual([]);
    expect(run(vad, 0.1, 20)).toEqual(["pause"]);
  });

  it("resumes only on real voice after a pause, not on a click", () => {
    const vad = new SpeechVad();
    run(vad, 0.9, 300);
    run(vad, 0.1, 460);
    expect(run(vad, 0.9, 40)).toEqual([]);
    expect(run(vad, 0.1, 40)).toEqual([]);
    expect(run(vad, 0.9, 100)).toEqual(["resume"]);
    expect(vad.voicedTotalMs).toBe(400);
  });

  it("ends only after a long silence, as a safety net when the server never decides", () => {
    const vad = new SpeechVad();
    run(vad, 0.9, 300);
    expect(run(vad, 0.1, 3400)).toEqual(["pause"]);
    expect(run(vad, 0.1, 100)).toEqual(["end"]);
  });

  it("keeps a long turn going while the owner talks, instead of cutting it at 30 seconds", () => {
    const vad = new SpeechVad();
    run(vad, 0.9, 200);
    expect(run(vad, 0.9, 60_000)).toEqual([]);
  });
});
