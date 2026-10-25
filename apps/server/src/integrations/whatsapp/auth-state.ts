import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from "baileys";
import type { TokenCipher } from "../../crypto/token-cipher.js";
import type { Db } from "../../db/database.js";

const CREDS_KEY = "creds";

export interface DbAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Forgets the whole session, so the next start begins a fresh pairing. */
  clear(): void;
  /** Re-encrypts rows still sealed with the previous key. */
  rewrap(): number;
}

const context = (key: string) => `wa_auth_state:${key}`;

/**
 * Baileys auth state kept in `wa_auth_state`, every value encrypted with the token cipher.
 * The reserved key `pairing` (see pairing-store) never collides with `creds` or `<type>-<id>` keys.
 */
export function useDbAuthState(db: Db, cipher: TokenCipher): DbAuthState {
  const write = (key: string, value: unknown, now = new Date()) => {
    const sealed = cipher.encrypt(JSON.stringify(value, BufferJSON.replacer), context(key));
    db.prepare(
      `INSERT INTO wa_auth_state (key, value_ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, updated_at = excluded.updated_at`,
    ).run(key, sealed, now.toISOString());
  };
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value_ciphertext FROM wa_auth_state WHERE key = ?").get(key) as { value_ciphertext: string } | undefined;
    return row ? JSON.parse(cipher.decrypt(row.value_ciphertext, context(key)), BufferJSON.reviver) : undefined;
  };

  const creds = (read(CREDS_KEY) as AuthenticationCreds | undefined) ?? initAuthCreds();

  const keys: AuthenticationState["keys"] = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const found: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const value = read(`${type}-${id}`);
        if (value === undefined) continue;
        found[id] = (type === "app-state-sync-key" ? proto.Message.AppStateSyncKeyData.fromObject(value as object) : value) as SignalDataTypeMap[T];
      }
      return found;
    },
    set: async (data: SignalDataSet) => {
      db.transaction(() => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value) write(`${type}-${id}`, value);
            else db.prepare("DELETE FROM wa_auth_state WHERE key = ?").run(`${type}-${id}`);
          }
        }
      }).immediate();
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => write(CREDS_KEY, creds),
    clear: () => void db.prepare("DELETE FROM wa_auth_state WHERE key != 'pairing'").run(),
    rewrap: () => {
      const rows = db.prepare("SELECT key, value_ciphertext FROM wa_auth_state").all() as { key: string; value_ciphertext: string }[];
      const stale = rows.filter((row) => !cipher.isCurrent(row.value_ciphertext));
      db.transaction(() => {
        for (const row of stale) {
          const plain = cipher.decrypt(row.value_ciphertext, context(row.key));
          db.prepare("UPDATE wa_auth_state SET value_ciphertext = ? WHERE key = ?").run(cipher.encrypt(plain, context(row.key)), row.key);
        }
      }).immediate();
      return stale.length;
    },
  };
}
