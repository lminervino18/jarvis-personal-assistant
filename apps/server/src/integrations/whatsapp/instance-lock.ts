import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class InstanceLockError extends Error {
  constructor(readonly holderPid: number) {
    super(`another WhatsApp bridge instance is running (pid ${holderPid})`);
  }
}

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

function readHolder(path: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes an exclusive lock file so only one bridge process ever holds the WhatsApp session. Two sessions
 * on one account replace each other and trigger the reconnect loops that get numbers flagged.
 * A lock left by a dead process (or by this same pid after a restart) is taken over.
 */
export function acquireInstanceLock(path: string, pid = process.pid, isAlive: (pid: number) => boolean = processIsAlive): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      return () => {
        if (readHolder(path) === pid) unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(path);
      if (holder !== undefined && holder !== pid && isAlive(holder)) throw new InstanceLockError(holder);
      unlinkSync(path);
    }
  }
  throw new InstanceLockError(0);
}
