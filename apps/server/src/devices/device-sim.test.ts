import { DEVICE_AUDIO_FORMAT, DeviceSimulator, encodeWav, parseWav, toneAudio, type SimulatorOptions } from "@jarvis/device-sim";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_ORIGIN, startDeviceTestServer, type DeviceTestServerOptions } from "./test-server.js";

const REPLY = "Son las diez de la noche. Algo más en lo que te ayude?";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pairedSimulator(options: DeviceTestServerOptions = {}, simulatorOptions: Partial<SimulatorOptions> = {}) {
  const server = await startDeviceTestServer({ reply: REPLY, ...options });
  cleanups.push(() => server.close());
  const cookie = await server.ownerCookie();
  const created = await fetch(`${server.httpUrl}/api/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: OWNER_ORIGIN, cookie },
    body: JSON.stringify({ name: "Simulador" }),
  });
  const { id, token } = (await created.json()) as { id: string; token: string };
  const simulator = new DeviceSimulator({
    url: server.wsUrl,
    token,
    reconnect: { minDelayMs: 20, maxDelayMs: 100 },
    ...simulatorOptions,
  });
  cleanups.push(() => simulator.close());
  return { server, simulator, cookie, deviceId: id, token };
}

function turnStatus(server: Awaited<ReturnType<typeof startDeviceTestServer>>, turnId: string): string | undefined {
  return (server.db.prepare("SELECT status FROM turns WHERE id = ?").get(turnId) as { status: string } | undefined)?.status;
}

describe("device simulator against the real server with fixture STT/TTS", () => {
  it("runs a full voice turn over /ws/device and produces a playable 16 kHz WAV", async () => {
    const { server, simulator } = await pairedSimulator({ engine: { msPerChar: 15 } });
    await simulator.connect();

    const result = await simulator.speak(toneAudio(1, DEVICE_AUDIO_FORMAT.sampleRate)).done;

    expect(result).toMatchObject({ status: "completed", transcript: "¿Qué hora es?", assistantText: REPLY, replyTruncated: false });
    expect(result.replyFormat).toEqual(DEVICE_AUDIO_FORMAT);
    expect(result.reply.byteLength).toBeGreaterThan(DEVICE_AUDIO_FORMAT.sampleRate);
    const wav = parseWav(encodeWav(result.reply, result.replyFormat?.sampleRate ?? 0));
    expect(wav.sampleRate).toBe(16000);
    expect(wav.pcm.byteLength).toBe(result.reply.byteLength);
    expect(turnStatus(server, result.turnId)).toBe("completed");
    expect(server.devices.list()[0]?.lastSeenAt).not.toBeNull();
    expect(simulator.stats.droppedFrames).toBe(0);
  });

  it("cancels a reply in flight and the server records the cancelled turn", async () => {
    const { server, simulator } = await pairedSimulator({ engine: { msPerChar: 80, chunkDelayMs: 20 } });
    await simulator.connect();
    const { turnId, done } = simulator.speak(toneAudio(0.5, DEVICE_AUDIO_FORMAT.sampleRate));
    await waitUntil(() => turnStatus(server, turnId) === "running");
    await new Promise((resolve) => setTimeout(resolve, 150));

    simulator.cancel("barge_in");

    const result = await done;
    expect(result.status).toBe("cancelled");
    expect(result.reply.byteLength).toBe(0);
    await waitUntil(() => turnStatus(server, turnId) === "cancelled");
    const dropped = simulator.stats.droppedFrames;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(simulator.stats.droppedFrames - dropped).toBeLessThanOrEqual(1);
  });

  it("reconnects after the connection drops and completes the next turn in the same conversation", async () => {
    const { server, simulator } = await pairedSimulator({ engine: { msPerChar: 10 } });
    await simulator.connect();
    const first = await simulator.speak(toneAudio(0.3, DEVICE_AUDIO_FORMAT.sampleRate)).done;
    expect(first.status).toBe("completed");

    server.terminateClients();
    await waitUntil(() => simulator.stats.reconnects === 1 && simulator.isReady());

    const second = await simulator.speak(toneAudio(0.3, DEVICE_AUDIO_FORMAT.sampleRate)).done;
    expect(second.status).toBe("completed");
    const conversations = server.db.prepare("SELECT DISTINCT conversation_id FROM turns").all();
    expect(conversations).toHaveLength(1);
  });

  it("stops reconnecting once the owner revokes the device", async () => {
    const { server, simulator, cookie, deviceId } = await pairedSimulator();
    await simulator.connect();

    const revoked = await fetch(`${server.httpUrl}/api/devices/${deviceId}/revoke`, { method: "POST", headers: { origin: OWNER_ORIGIN, cookie } });
    expect(revoked.status).toBe(200);

    await waitUntil(() => simulator.stats.fatal !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(simulator.stats.reconnects).toBe(0);
    expect(simulator.isReady()).toBe(false);
  });

  it("refuses a token the server does not know", async () => {
    const { server } = await pairedSimulator();
    const stranger = new DeviceSimulator({ url: server.wsUrl, token: "not-a-paired-token" });
    cleanups.push(() => stranger.close());
    await expect(stranger.connect(2000)).rejects.toThrow("unauthorized");
  });
});
