import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAuthCreds, proto, type AuthenticationState, type BaileysEventMap, type WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenCipher } from "../../crypto/token-cipher.js";
import { openMigratedDatabase } from "../../db/database.js";
import { useDbAuthState } from "./auth-state.js";
import { ownChat, WhatsAppBridge, type BridgeSocket, type OutgoingContent } from "./bridge.js";
import { InstanceLockError, acquireInstanceLock, processIsAlive } from "./instance-lock.js";
import { WhatsAppStore } from "./message-store.js";
import { PairingStore } from "./pairing-store.js";
import { ReconnectPolicy } from "./reconnect-policy.js";
import { BRIDGE_BROWSER, conservativeSocketConfig } from "./socket-config.js";
import { WhatsAppStatusSource } from "./status.js";
import { loadBaileysFixture } from "./test-support.js";
import { OWN_CHAT, WhatsAppOutbox } from "./outbox.js";

const START = new Date("2026-10-26T12:00:00Z");
const fixture = loadBaileysFixture<{ live: WAMessage[]; history: BaileysEventMap["messaging-history.set"] }>();

class FakeSocket implements BridgeSocket {
  readonly emitter = new EventEmitter();
  ended = 0;
  readonly ev = {
    on: <E extends keyof BaileysEventMap>(event: E, listener: (data: BaileysEventMap[E]) => void) => void this.emitter.on(event, listener),
  };
  readonly sent: { jid: string; text: string }[] = [];
  readonly contents: OutgoingContent[] = [];
  readonly quoted: unknown[] = [];
  failNext = false;
  readonly codesAsked: string[] = [];
  async requestPairingCode(phone: string) {
    this.codesAsked.push(phone);
    return "ABCD2345";
  }
  end() {
    this.ended += 1;
  }
  async sendMessage(jid: string, content: OutgoingContent, options?: { quoted?: unknown }) {
    if (options?.quoted) this.quoted.push(options.quoted);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("send failed");
    }
    this.contents.push(content);
    this.sent.push({ jid, text: "text" in content ? content.text : "caption" in content ? content.caption : "" });
    return { key: { id: `sent-${this.sent.length}` } };
  }
  emit<E extends keyof BaileysEventMap>(event: E, data: BaileysEventMap[E]) {
    this.emitter.emit(event, data);
  }
  open() {
    this.emit("connection.update", { connection: "open" });
  }
  close(statusCode: number) {
    this.emit("connection.update", { connection: "close", lastDisconnect: { error: Object.assign(new Error("closed"), { output: { statusCode } }), date: new Date() } });
  }
}

function setupOptions(db: ReturnType<typeof openMigratedDatabase>, log: { info: () => void; warn: () => void; error: () => void }) {
  const cipher = new TokenCipher(randomBytes(32));
  return {
    store: new WhatsAppStore(db),
    auth: useDbAuthState(db, cipher),
    pairing: new PairingStore(db, cipher),
    policy: new ReconnectPolicy({ baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: 8, random: () => 0.5 }),
    log,
    connect: () => new FakeSocket(),
  };
}

function setup(options: { notifyCode?: (code: string) => void; paired?: boolean; random?: number; maxAttempts?: number; files?: Map<string, { attachment: { name: string; mediaType: string }; data: Buffer }> } = {}) {
  const db = openMigratedDatabase(":memory:");
  const cipher = new TokenCipher(randomBytes(32));
  const store = new WhatsAppStore(db);
  const auth = useDbAuthState(db, cipher);
  if (options.paired !== false) Object.assign(auth.state.creds, { me: { id: "5490000000099:1@s.whatsapp.net" }, registered: true });
  const pairing = new PairingStore(db, cipher);
  const outbox = new WhatsAppOutbox(db);
  const sockets: FakeSocket[] = [];
  const policy = new ReconnectPolicy({ baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: options.maxAttempts ?? 8, random: () => options.random ?? 0.5 });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bridge = new WhatsAppBridge({
    store,
    auth,
    pairing,
    ...(options.notifyCode ? { notifyCode: options.notifyCode } : {}),
    outbox,
    ...(options.files ? { files: { read: (id: string) => options.files?.get(id) } } : {}),
    policy,
    log,
    now: () => new Date(),
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const status = () => db.prepare("SELECT status, detail FROM wa_sync_state WHERE source = 'baileys'").get() as { status: string; detail: string | null } | undefined;
  const count = () => (db.prepare("SELECT count(*) AS n FROM wa_messages").get() as { n: number }).n;
  const askToConnect = (mode: "code" | "qr" = "qr") => {
    store.requestWake(new Date(), mode);
    vi.advanceTimersByTime(5_000);
  };
  return { db, cipher, store, auth, pairing, outbox, bridge, sockets, status, count, log, askToConnect };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe("bridge lifecycle", () => {
  it("records messages while open and reports a connected status with heartbeats", () => {
    const { bridge, sockets, status, count, db } = setup();
    bridge.start();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(status()).toEqual({ status: "connected", detail: null });

    sockets[0]?.emit("messages.upsert", { messages: fixture.live, type: "notify" });
    expect(count()).toBe(3);

    vi.advanceTimersByTime(60_000);
    expect(db.prepare("SELECT last_event_at FROM wa_sync_state WHERE source = 'baileys'").get()).toEqual({ last_event_at: "2026-10-26T12:01:00.000Z" });
  });

  it("links with a code to the saved number when the owner taps Vincular, without a QR", async () => {
    const { bridge, sockets, status, pairing, db, askToConnect } = setup({ paired: false });
    pairing.rememberNumber("5491100000000", new Date());
    bridge.start();
    askToConnect("code");
    expect(status()).toEqual({ status: "pairing", detail: "Conectando…" });
    sockets[0]?.emit("connection.update", { qr: "qr-ignored" });
    sockets[0]?.emit("connection.update", { qr: "qr-ignored-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]?.codesAsked).toEqual(["5491100000000"]);
    expect(pairing.card(new Date())).toMatchObject({ kind: "pairing", code: "ABCD-2345" });
    expect(pairing.card(new Date())?.qr).toBeUndefined();
    expect(status()).toEqual({ status: "pairing", detail: "Esperando el código." });
    const stored = (db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = 'pairing'").get() as { value_ciphertext: string }).value_ciphertext;
    expect(stored).not.toContain("ABCD");
  });

  it("tells the owner the code by notification", async () => {
    const notified: string[] = [];
    const { bridge, sockets, pairing, askToConnect } = setup({ paired: false, notifyCode: (code) => notified.push(code) });
    pairing.rememberNumber("5491100000000", new Date());
    bridge.start();
    askToConnect("code");
    sockets[0]?.emit("connection.update", { qr: "qr" });
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toEqual(["ABCD-2345"]);
  });

  it("keeps linking when the notification of the code fails", async () => {
    const { bridge, sockets, pairing, status, askToConnect } = setup({
      paired: false,
      notifyCode: () => {
        throw new Error("database is locked");
      },
    });
    pairing.rememberNumber("5491100000000", new Date());
    bridge.start();
    askToConnect("code");
    sockets[0]?.emit("connection.update", { qr: "qr" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pairing.card(new Date())).toMatchObject({ code: "ABCD-2345" });
    expect(status()).toEqual({ status: "pairing", detail: "Esperando el código." });
    expect(sockets[0]?.ended).toBe(0);
  });

  it("shows a QR only when the owner asked for one", () => {
    const { bridge, sockets, pairing, store } = setup({ paired: false });
    bridge.start();
    store.requestWake(new Date(), "qr");
    vi.advanceTimersByTime(5_000);
    sockets[0]?.emit("connection.update", { qr: "qr-asked" });
    expect(pairing.card(new Date())).toMatchObject({ qr: "qr-asked" });
  });

  it("never offers a QR or a code by itself, and says so when there is no saved number", async () => {
    const { bridge, sockets, status, askToConnect } = setup({ paired: false });
    bridge.start();
    expect(sockets).toHaveLength(0);
    expect(status()?.status).toBe("logged_out");
    askToConnect("code");
    sockets[0]?.emit("connection.update", { qr: "qr" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]?.codesAsked).toEqual([]);
    expect(status()).toEqual({ status: "logged_out", detail: expect.stringContaining("número") });
  });

  it("takes a wake request once, by mode, and lets an old one lapse", () => {
    const { store } = setup();
    store.setStatus("baileys", "logged_out", new Date());
    store.requestWake(new Date(), "code");
    expect(store.takeWake(new Date())).toBe("code");
    expect(store.takeWake(new Date())).toBeUndefined();
    store.requestWake(new Date(), "qr");
    expect(store.takeWake(new Date(Date.now() + 3 * 60_000))).toBeUndefined();
  });

  it("rewraps the saved number with the others", () => {
    const { auth, pairing } = setup();
    pairing.rememberNumber("5491100000000", new Date());
    auth.rewrap();
    expect(pairing.number()).toBe("5491100000000");
  });

  it("remembers the owner's number from the linked session, and keeps it after the session closes", () => {
    const { bridge, sockets, pairing } = setup();
    bridge.start();
    expect(pairing.number()).toBe("5490000000099");
    sockets[0]?.open();
    sockets[0]?.close(401);
    expect(pairing.number()).toBe("5490000000099");
  });

  it("publishes the pairing QR privately and clears it once linked", () => {
    const { bridge, sockets, status, pairing, db, askToConnect } = setup({ paired: false });
    bridge.start();
    askToConnect();
    sockets[0]?.emit("connection.update", { qr: "qr-secret-fixture" });
    expect(status()?.status).toBe("pairing");
    expect(pairing.card(new Date())).toMatchObject({ kind: "pairing", provider: "whatsapp", qr: "qr-secret-fixture" });
    const stored = (db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = 'pairing'").get() as { value_ciphertext: string }).value_ciphertext;
    expect(stored).not.toContain("qr-secret-fixture");

    vi.advanceTimersByTime(61_000);
    expect(pairing.card(new Date())).toBeUndefined();

    sockets[0]?.emit("connection.update", { qr: "qr-2" });
    sockets[0]?.open();
    expect(pairing.card(new Date())).toBeUndefined();
  });

  it("persists credentials when they change", async () => {
    const { bridge, sockets, db } = setup();
    bridge.start();
    sockets[0]?.emit("creds.update", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(db.prepare("SELECT count(*) AS n FROM wa_auth_state WHERE key = 'creds'").get()).toEqual({ n: 1 });
  });

  it("survives a failing event handler without logging message content", () => {
    const { bridge, sockets, log } = setup();
    bridge.start();
    sockets[0]?.emit("messages.upsert", { messages: [{ key: null } as unknown as WAMessage], type: "notify" });
    expect(log.error).toHaveBeenCalledWith({ event: "messages.upsert", error: "TypeError" }, "whatsapp event handler failed");
    expect(bridge.phase).toBe("connecting");
  });

  it("stop ends the socket and records the status", () => {
    const { bridge, sockets, status } = setup();
    bridge.start();
    sockets[0]?.open();
    bridge.stop();
    expect(sockets[0]?.ended).toBe(1);
    expect(status()).toEqual({ status: "disconnected", detail: "Puente detenido." });
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("reconnection", () => {
  it("backs off exponentially with jitter and replays without duplicating messages", () => {
    const { bridge, sockets, count, status } = setup({ random: 0 });
    bridge.start();
    sockets[0]?.open();
    sockets[0]?.emit("messages.upsert", { messages: fixture.live, type: "notify" });

    sockets[0]?.close(408);
    expect(status()).toEqual({ status: "disconnected", detail: "Reconectando (intento 1)." });
    vi.advanceTimersByTime(2_499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]?.emit("messages.upsert", { messages: fixture.live, type: "notify" });
    expect(count()).toBe(3);

    sockets[1]?.close(408);
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(3);
    sockets[2]?.close(408);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(4);
  });

  it("keeps the delay inside the jitter window and below the cap", () => {
    const policy = new ReconnectPolicy({ baseDelayMs: 5_000, maxDelayMs: 300_000, maxAttempts: 20, random: () => 0.999 });
    const delays = Array.from({ length: 10 }, () => (policy.decide(408, true) as { delayMs: number }).delayMs);
    expect(delays.slice(0, 3)).toEqual([5_000, 10_000, 20_000].map((ms) => Math.round(ms * 0.5 + ms * 0.5 * 0.999)));
    expect(Math.max(...delays)).toBeLessThanOrEqual(300_000);
  });

  it("after the quick attempts, keeps trying once every half hour", () => {
    const { bridge, sockets, status } = setup({ maxAttempts: 3 });
    bridge.start();
    for (let attempt = 0; attempt < 3; attempt++) {
      sockets.at(-1)?.close(408);
      vi.advanceTimersByTime(300_000);
    }
    expect(sockets).toHaveLength(4);
    sockets.at(-1)?.close(408);
    expect(status()).toEqual({ status: "disconnected", detail: "Sin conexión; vuelvo a probar en 30 minutos." });
    vi.advanceTimersByTime(25 * 60_000);
    expect(sockets).toHaveLength(4);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(5);
  });

  it("connects right away when the owner asks during a slow wait", () => {
    const { bridge, sockets, askToConnect } = setup({ maxAttempts: 1 });
    bridge.start();
    sockets[0]?.close(408);
    vi.advanceTimersByTime(300_000);
    sockets[1]?.close(408);
    askToConnect();
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(60 * 60_000);
    expect(sockets).toHaveLength(3);
  });

  it("resets the attempt counter only after a connection has been stable", () => {
    const { bridge, sockets } = setup({ maxAttempts: 2 });
    bridge.start();
    sockets[0]?.close(408);
    vi.advanceTimersByTime(300_000);
    sockets[1]?.open();
    sockets[1]?.close(408);
    vi.advanceTimersByTime(300_000);
    sockets[2]?.open();
    vi.advanceTimersByTime(120_000);
    sockets[2]?.close(408);
    vi.advanceTimersByTime(300_000);
    expect(sockets).toHaveLength(4);
    expect(bridge.phase).toBe("connecting");
  });

  it("reconnects quickly when WhatsApp asks for a restart after pairing", () => {
    const { bridge, sockets, askToConnect } = setup({ paired: false });
    bridge.start();
    askToConnect();
    sockets[0]?.close(515);
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
  });

  it("ignores events from a socket that was already replaced", () => {
    const { bridge, sockets, count } = setup();
    bridge.start();
    sockets[0]?.close(408);
    vi.advanceTimersByTime(300_000);
    sockets[0]?.emit("messages.upsert", { messages: fixture.live, type: "notify" });
    sockets[0]?.close(401);
    expect(count()).toBe(0);
    expect(bridge.phase).toBe("connecting");
  });
});

describe("terminal states", () => {
  it("stops and wipes the session on logout", () => {
    const { bridge, sockets, status, db } = setup();
    bridge.start();
    sockets[0]?.open();
    sockets[0]?.close(401);
    expect(status()).toMatchObject({ status: "logged_out" });
    expect(db.prepare("SELECT key FROM wa_auth_state").all()).toEqual([{ key: "owner_number" }]);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(bridge.phase).toBe("stopped");
  });

  it("stops on a bad session, a replaced session and a forbidden connection", () => {
    for (const code of [500, 440, 403, 411]) {
      const { bridge, sockets, status } = setup();
      bridge.start();
      sockets[0]?.close(code);
      vi.advanceTimersByTime(60 * 60_000);
      expect(sockets).toHaveLength(1);
      expect(status()?.status).toBe("error");
    }
  });

  it("keeps the session on a replaced connection but wipes it on a bad session", () => {
    const replaced = setup();
    replaced.auth.state.keys.set({ "pre-key": { "1": { private: Buffer.from("k"), public: Buffer.from("p") } } });
    replaced.bridge.start();
    replaced.sockets[0]?.close(440);
    expect(replaced.db.prepare("SELECT count(*) AS n FROM wa_auth_state WHERE key != 'owner_number'").get()).toEqual({ n: 1 });

    const bad = setup();
    bad.auth.state.keys.set({ "pre-key": { "1": { private: Buffer.from("k"), public: Buffer.from("p") } } });
    bad.bridge.start();
    bad.sockets[0]?.close(500);
    expect(bad.db.prepare("SELECT count(*) AS n FROM wa_auth_state WHERE key != 'owner_number'").get()).toEqual({ n: 0 });
  });

  it("does not loop on QR codes when pairing is never completed", () => {
    const { bridge, sockets, status, askToConnect } = setup({ paired: false });
    bridge.start();
    askToConnect();
    sockets[0]?.emit("connection.update", { qr: "qr-1" });
    sockets[0]?.close(408);
    vi.advanceTimersByTime(60 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(status()).toMatchObject({ status: "logged_out" });
    expect(status()?.detail).toContain("venció sin vincularse");
  });

  it("without a session, waits for the owner and offers a QR only when asked", () => {
    const { bridge, sockets, status, askToConnect } = setup({ paired: false });
    bridge.start();
    vi.advanceTimersByTime(60 * 60_000);
    expect(sockets).toHaveLength(0);
    expect(status()).toEqual({ status: "logged_out", detail: "Hay que vincular WhatsApp: tocá «Vincular» en Configuración." });
    askToConnect();
    expect(sockets).toHaveLength(1);
  });

  it("after a logout, connects again only when the owner asks, never on an old request", () => {
    const { bridge, sockets, store, askToConnect } = setup();
    bridge.start();
    sockets[0]?.open();
    store.requestWake(new Date());
    vi.advanceTimersByTime(3 * 60_000);
    sockets[0]?.close(401);
    vi.advanceTimersByTime(60 * 60_000);
    expect(sockets).toHaveLength(1);
    askToConnect();
    expect(sockets).toHaveLength(2);
  });
});

describe("auth state", () => {
  it("round-trips credentials and keys encrypted, including binary values", async () => {
    const db = openMigratedDatabase(":memory:");
    const cipher = new TokenCipher(randomBytes(32));
    const first = useDbAuthState(db, cipher);
    const secret = Buffer.from("signal-private-key-fixture");
    await first.state.keys.set({
      "pre-key": { "7": { private: secret, public: Buffer.from("pub") } },
      session: { "a.1": new Uint8Array([1, 2, 3]) },
      "app-state-sync-key": { k1: { keyData: new Uint8Array([9, 9]), timestamp: 1 } },
    });
    first.state.creds.registered = true;
    await first.saveCreds();

    const raw = JSON.stringify(db.prepare("SELECT value_ciphertext FROM wa_auth_state").all());
    expect(raw).not.toContain(secret.toString("base64"));
    expect(raw).not.toContain("signal-private-key");

    const second = useDbAuthState(db, cipher);
    expect(second.state.creds.registered).toBe(true);
    expect(Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private))).toBe(true);
    const preKeys = await second.state.keys.get("pre-key", ["7", "8"]);
    expect(Buffer.from(preKeys["7"]?.private ?? []).toString()).toBe("signal-private-key-fixture");
    expect(preKeys["8"]).toBeUndefined();
    expect(Array.from((await second.state.keys.get("session", ["a.1"]))["a.1"] ?? [])).toEqual([1, 2, 3]);
    expect((await second.state.keys.get("app-state-sync-key", ["k1"])).k1).toBeInstanceOf(proto.Message.AppStateSyncKeyData);

    await second.state.keys.set({ "pre-key": { "7": null } });
    expect((await useDbAuthState(db, cipher).state.keys.get("pre-key", ["7"]))["7"]).toBeUndefined();
  });

  it("cannot be read without the key and rewraps after rotation", async () => {
    const db = openMigratedDatabase(":memory:");
    const oldKey = randomBytes(32);
    const old = useDbAuthState(db, new TokenCipher(oldKey));
    await old.saveCreds();
    expect(() => useDbAuthState(db, new TokenCipher(randomBytes(32)))).toThrow();

    const rotated = useDbAuthState(db, new TokenCipher(randomBytes(32), oldKey));
    expect(rotated.rewrap()).toBe(1);
    expect(rotated.rewrap()).toBe(0);
  });

  it("starts from fresh credentials when nothing is stored", () => {
    const fresh = useDbAuthState(openMigratedDatabase(":memory:"), new TokenCipher(randomBytes(32)));
    expect(fresh.state.creds.registered).toBe(false);
    expect(Object.keys(fresh.state.creds)).toEqual(Object.keys(initAuthCreds()));
  });
});

describe("instance lock", () => {
  it("does not mistake one of its own threads for another bridge", () => {
    const thread = readdirSync(`/proc/${process.pid}/task`).map(Number).find((id) => id !== process.pid);
    expect(thread).toBeDefined();
    expect(processIsAlive(thread as number)).toBe(false);
    expect(processIsAlive(process.pid)).toBe(true);
  });

  let dir: string;
  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "jarvis-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a second live instance and takes over stale locks", () => {
    const path = join(dir, "bridge.lock");
    const release = acquireInstanceLock(path, 111, () => true);
    expect(() => acquireInstanceLock(path, 222, () => true)).toThrow(InstanceLockError);
    expect(existsSync(path)).toBe(true);

    const takeover = acquireInstanceLock(path, 222, () => false);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
    release();
    expect(existsSync(path)).toBe(true);
    takeover();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes over a lock left by the same pid and by a corrupt file", () => {
    const path = join(dir, "bridge.lock");
    acquireInstanceLock(path, 111, () => true);
    expect(() => acquireInstanceLock(path, 111, () => true)).not.toThrow();
    writeFileSync(path, "not json");
    expect(() => acquireInstanceLock(path, 333, () => true)).not.toThrow();
  });
});

describe("conservative configuration", () => {
  const config = conservativeSocketConfig(undefined as never);

  it("never announces presence, never asks for full history and keeps a fixed identity", () => {
    expect(config.markOnlineOnConnect).toBe(false);
    expect(config.syncFullHistory).toBe(false);
    expect(config.browser).toEqual(["Ubuntu", "Chrome", "22.04.4"]);
    expect(BRIDGE_BROWSER).toBe(config.browser);
    const shouldSync = config.shouldSyncHistoryMessage as (message: { syncType: number }) => boolean;
    expect(shouldSync({ syncType: proto.HistorySync.HistorySyncType.FULL })).toBe(false);
    expect(shouldSync({ syncType: proto.HistorySync.HistorySyncType.ON_DEMAND })).toBe(false);
    expect(shouldSync({ syncType: proto.HistorySync.HistorySyncType.RECENT })).toBe(true);
  });

  it("ignores statuses, broadcast lists and newsletters", () => {
    const ignore = config.shouldIgnoreJid as (jid: string) => boolean;
    expect(ignore("status@broadcast")).toBe(true);
    expect(ignore("123@newsletter")).toBe(true);
    expect(ignore("5490000000001@s.whatsapp.net")).toBe(false);
  });

  it("tells the server which account is linked, and forgets it when the phone unlinks the device", () => {
    const { pairing, bridge, sockets } = setup();
    bridge.start();
    sockets[0]?.open();
    expect(pairing.account()).toEqual({ number: "5490000000099" });
    sockets[0]?.close(401);
    expect(pairing.account()).toBeUndefined();
  });

  it("shows the message it answers quoted above the reply", async () => {
    const { outbox, bridge, sockets } = setup();
    bridge.start();
    sockets[0]?.open();
    const group = "120363000000000001@g.us";
    outbox.enqueue({ id: "q1", chatJid: group, text: "🤖 Fue Argentina.", quote: { id: "ABC", participant: "5491100000002@s.whatsapp.net", fromMe: false, text: "@jarvis quién ganó el 86" } }, new Date());
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.quoted).toEqual([
      { key: { remoteJid: group, id: "ABC", fromMe: false, participant: "5491100000002@s.whatsapp.net" }, message: { conversation: "@jarvis quién ganó el 86" } },
    ]);
  });

  it("sends confirmed messages one at a time, records failures and never retries an interrupted send", async () => {
    const { db, outbox, bridge, sockets, log } = setup();
    bridge.start();
    sockets[0]?.open();
    const jid = "5490000000001@s.whatsapp.net";
    outbox.enqueue({ id: "m1", chatJid: jid, text: "llego en 10" }, new Date());
    outbox.enqueue({ id: "m2", chatJid: jid, text: "dale" }, new Date(Date.now() + 1));
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.sent).toEqual([{ jid, text: "llego en 10" }]);
    expect(outbox.status("m1")).toEqual({ status: "sent", error: null });
    sockets[0]!.failNext = true;
    await bridge.sendNextConfirmed();
    expect(outbox.status("m2")).toMatchObject({ status: "failed", error: "Error" });

    outbox.enqueue({ id: "m3", chatJid: jid, text: "otra" }, new Date(Date.now() + 2));
    outbox.claimNext(new Date());
    bridge.stop();
    const restarted = new WhatsAppBridge({ ...setupOptions(db, log), outbox });
    expect(outbox.status("m3")).toMatchObject({ status: "unknown" });
    await restarted.sendNextConfirmed();
    expect(sockets[0]?.sent).toHaveLength(1);
  });

  it("delivers notes to self to the paired number's own chat", async () => {
    const { outbox, bridge, sockets } = setup();
    bridge.start();
    sockets[0]?.open();
    outbox.enqueue({ id: "self-1", chatJid: OWN_CHAT, text: "instagram.com/ejemplo" }, new Date());
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.sent).toEqual([{ jid: "5490000000099@s.whatsapp.net", text: "instagram.com/ejemplo" }]);
    expect(ownChat("5490000000099:12@s.whatsapp.net")).toBe("5490000000099@s.whatsapp.net");
    expect(ownChat(undefined)).toBeUndefined();
  });

  it("sends an attached photo with its caption, and a document with its name", async () => {
    const files = new Map([
      ["photo-1", { attachment: { name: "cena.jpg", mediaType: "image/jpeg" }, data: Buffer.from("jpeg") }],
      ["doc-1", { attachment: { name: "menu.pdf", mediaType: "application/pdf" }, data: Buffer.from("pdf") }],
    ]);
    const { db, outbox, bridge, sockets } = setup({ files });
    for (const [id, file] of files) {
      db.prepare("INSERT INTO attachments (id, name, media_type, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, file.attachment.name, file.attachment.mediaType, 4, "x", START.toISOString());
    }
    bridge.start();
    sockets[0]?.open();
    outbox.enqueue({ id: "w1", chatJid: OWN_CHAT, text: "mirá", attachmentId: "photo-1" }, new Date());
    outbox.enqueue({ id: "w2", chatJid: OWN_CHAT, text: "el menú", attachmentId: "doc-1" }, new Date(Date.now() + 1));
    await bridge.sendNextConfirmed();
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.contents).toEqual([
      { image: Buffer.from("jpeg"), caption: "mirá", mimetype: "image/jpeg" },
      { document: Buffer.from("pdf"), mimetype: "application/pdf", fileName: "menu.pdf", caption: "el menú" },
    ]);
  });

  it("forwards a video with its caption, and an audio as a voice note after the text", async () => {
    const files = new Map([
      ["video-1", { attachment: { name: "fiesta.mp4", mediaType: "video/mp4" }, data: Buffer.from("mp4") }],
      ["audio-1", { attachment: { name: "nota.ogg", mediaType: "audio/ogg" }, data: Buffer.from("ogg") }],
    ]);
    const { db, outbox, bridge, sockets } = setup({ files });
    for (const [id, file] of files) {
      db.prepare("INSERT INTO attachments (id, name, media_type, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, file.attachment.name, file.attachment.mediaType, 3, "x", START.toISOString());
    }
    bridge.start();
    sockets[0]?.open();
    outbox.enqueue({ id: "w1", chatJid: OWN_CHAT, text: "la fiesta", attachmentId: "video-1" }, new Date());
    outbox.enqueue({ id: "w2", chatJid: OWN_CHAT, text: "te reenvío el audio de Ana", attachmentId: "audio-1" }, new Date(Date.now() + 1));
    await bridge.sendNextConfirmed();
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.contents).toEqual([
      { video: Buffer.from("mp4"), caption: "la fiesta", mimetype: "video/mp4" },
      { text: "te reenvío el audio de Ana" },
      { audio: Buffer.from("ogg"), mimetype: "audio/ogg", ptt: true },
    ]);
    expect(outbox.status("w2")).toMatchObject({ status: "sent" });
  });

  it("sends a voice note without text as a single fresh recording", async () => {
    const files = new Map([["voz-1", { attachment: { name: "nota-de-voz.ogg", mediaType: "audio/ogg; codecs=opus" }, data: Buffer.from("opus") }]]);
    const { db, outbox, bridge, sockets } = setup({ files });
    db.prepare("INSERT INTO attachments (id, name, media_type, size, sha256, created_at) VALUES ('voz-1', 'nota-de-voz.ogg', 'audio/ogg; codecs=opus', 4, 'x', ?)").run(START.toISOString());
    bridge.start();
    sockets[0]?.open();
    outbox.enqueue({ id: "v1", chatJid: OWN_CHAT, text: "", attachmentId: "voz-1" }, new Date());
    await bridge.sendNextConfirmed();
    expect(sockets[0]?.contents).toEqual([{ audio: Buffer.from("opus"), mimetype: "audio/ogg; codecs=opus", ptt: true }]);
  });

  it("sends only from the confirmed outbox and never marks as read or announces presence", () => {
    const sendCalls = readFileSync(new URL("bridge.ts", import.meta.url), "utf8").match(/\.sendMessage\(/g) ?? [];
    expect(sendCalls).toHaveLength(1);
    const forbidden = /\b(sendPresenceUpdate|presenceSubscribe|readMessages|sendReceipt|sendReceipts|fetchMessageHistory|requestPlaceholderResend|updateMediaMessage|relayMessage|groupFetchAllParticipating|chatModify|logout)\b/;
    const files = [
      ...readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-support.ts").map((name) => new URL(name, import.meta.url)),
      new URL("../../whatsapp-bridge.ts", import.meta.url),
    ];
    for (const file of files) expect({ file: file.pathname, match: forbidden.exec(readFileSync(file, "utf8"))?.[0] }).toEqual({ file: file.pathname, match: undefined });
  });
});

describe("status source", () => {
  it("reports disabled when the bridge never ran and imports as empty", async () => {
    const db = openMigratedDatabase(":memory:");
    const items = await new WhatsAppStatusSource(db, "America/Argentina/Buenos_Aires").status();
    expect(items).toEqual([
      expect.objectContaining({ provider: "whatsapp", account: "baileys", status: "disabled" }),
      expect.objectContaining({ provider: "whatsapp", account: "import", status: "disconnected" }),
    ]);
  });

  it("maps bridge states and flags a silent bridge", async () => {
    const { db, bridge, sockets } = setup();
    const source = new WhatsAppStatusSource(db, "America/Argentina/Buenos_Aires", undefined, () => new Date());
    const bridgeStatus = async () => (await source.status())[0];

    bridge.start();
    sockets[0]?.open();
    expect(await bridgeStatus()).toMatchObject({ status: "connected" });
    vi.setSystemTime(new Date(START.getTime() + 4 * 60_000));
    expect(await bridgeStatus()).toMatchObject({ status: "disconnected", detail: "El puente no da señales de vida." });

    sockets[0]?.close(401);
    expect(await bridgeStatus()).toMatchObject({ status: "needs_action" });
  });

  it("exposes the pairing card while a QR is pending", async () => {
    const { db, bridge, sockets, pairing, askToConnect } = setup({ paired: false });
    const source = new WhatsAppStatusSource(db, "America/Argentina/Buenos_Aires", pairing, () => new Date());
    bridge.start();
    askToConnect();
    expect(source.pairingCard()).toBeUndefined();
    sockets[0]?.emit("connection.update", { qr: "qr-fixture" });
    expect(source.pairingCard()).toMatchObject({ kind: "pairing", qr: "qr-fixture" });
    expect((await source.status())[0]).toMatchObject({ status: "needs_action" });
  });
});

describe("authenticated state type", () => {
  it("is what the socket factory receives", () => {
    const { bridge, auth } = setup();
    let received: AuthenticationState | undefined;
    const spy = new WhatsAppBridge({
      store: new WhatsAppStore(openMigratedDatabase(":memory:")),
      auth,
      pairing: { publish() {}, publishCode() {}, rememberNumber() {}, number: () => undefined, clear() {}, publishAccount() {}, forgetAccount() {} },
      policy: new ReconnectPolicy(),
      log: { info() {}, warn() {}, error() {} },
      connect: (state) => {
        received = state;
        return new FakeSocket();
      },
    });
    spy.start();
    expect(received).toBe(auth.state);
    bridge.stop();
  });
});
