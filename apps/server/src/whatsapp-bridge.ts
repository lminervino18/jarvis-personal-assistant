import { resolve } from "node:path";
import makeWASocket from "baileys";
import { TokenCipher } from "./crypto/token-cipher.js";
import { openMigratedDatabase } from "./db/database.js";
import { useDbAuthState } from "./integrations/whatsapp/auth-state.js";
import { WhatsAppBridge } from "./integrations/whatsapp/bridge.js";
import { InstanceLockError, acquireInstanceLock } from "./integrations/whatsapp/instance-lock.js";
import { WhatsAppStore } from "./integrations/whatsapp/message-store.js";
import { PairingStore } from "./integrations/whatsapp/pairing-store.js";
import { DEFAULT_RECONNECT, ReconnectPolicy } from "./integrations/whatsapp/reconnect-policy.js";
import { conservativeSocketConfig } from "./integrations/whatsapp/socket-config.js";
import { createLogger } from "./logger.js";

const STARTUP_DELAY_MS = 15_000;
const STARTUP_JITTER_MS = 10_000;

const log = createLogger(process.env.LOG_LEVEL ?? "info").child({ component: "whatsapp-bridge" });
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const db = openMigratedDatabase(resolve(dataDir, "jarvis.db"));
const store = new WhatsAppStore(db);

const idleUntilSignal = (reason: string) => {
  log.warn(reason);
  setInterval(() => {}, 60_000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
};

async function run(): Promise<void> {
  if (process.env.WHATSAPP_ENABLED !== "true") {
    store.setStatus("baileys", "disabled", new Date(), "Puente desactivado (WHATSAPP_ENABLED no es true).");
    return idleUntilSignal("WhatsApp bridge disabled: set WHATSAPP_ENABLED=true to enable it");
  }
  const cipher = TokenCipher.fromEnv(process.env);
  if (!cipher) return idleUntilSignal("WhatsApp bridge not started: TOKEN_ENCRYPTION_KEY is required to store the session");

  let releaseLock: () => void;
  try {
    releaseLock = acquireInstanceLock(resolve(dataDir, "whatsapp-bridge.lock"));
  } catch (error) {
    if (error instanceof InstanceLockError) return idleUntilSignal(error.message);
    throw error;
  }
  const auth = useDbAuthState(db, cipher);
  auth.rewrap();
  const bridge = new WhatsAppBridge({
    store,
    auth,
    pairing: new PairingStore(db, cipher),
    policy: new ReconnectPolicy(DEFAULT_RECONNECT),
    log,
    connect: (state) => makeWASocket({ ...conservativeSocketConfig(log.child({ library: "baileys" }, { level: "warn" })), auth: state }),
  });

  const shutdown = () => {
    bridge.stop();
    releaseLock();
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const delayMs = STARTUP_DELAY_MS + Math.random() * STARTUP_JITTER_MS;
  log.info({ delayMs: Math.round(delayMs) }, "waiting before connecting to WhatsApp");
  setTimeout(() => bridge.start(), delayMs);
}

await run();
