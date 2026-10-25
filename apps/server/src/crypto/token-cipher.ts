import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class TokenDecryptionError extends Error {
  constructor() {
    super("encrypted value could not be decrypted");
  }
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Decodes a base64 key and checks it is exactly 32 bytes. The key never appears in errors. */
export function parseEncryptionKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes encoded as base64`);
  return key;
}

/**
 * AES-256-GCM for tokens and session material stored in SQLite. Ciphertexts look like
 * `v1.<keyId>.<iv>.<tag>.<data>` (base64url) and are bound to a context string, so a
 * value copied to another row or purpose fails authentication. A previous key can be
 * kept for decryption while values are rewrapped with the current one.
 */
export class TokenCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentId: string;

  constructor(
    private readonly current: Buffer,
    previous?: Buffer,
  ) {
    this.currentId = keyId(current);
    this.keys.set(this.currentId, current);
    if (previous) this.keys.set(keyId(previous), previous);
  }

  /** Builds a cipher from TOKEN_ENCRYPTION_KEY (and optional _PREVIOUS); undefined when unset. */
  static fromEnv(env: NodeJS.ProcessEnv): TokenCipher | undefined {
    if (!env.TOKEN_ENCRYPTION_KEY) return undefined;
    const current = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY");
    const previous = env.TOKEN_ENCRYPTION_KEY_PREVIOUS
      ? parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY_PREVIOUS, "TOKEN_ENCRYPTION_KEY_PREVIOUS")
      : undefined;
    return new TokenCipher(current, previous);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.currentId, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
  }

  decrypt(ciphertext: string, context: string): string {
    const [version, id, iv, tag, data] = ciphertext.split(".");
    const key = id ? this.keys.get(id) : undefined;
    if (version !== VERSION || !key || iv === undefined || tag === undefined || data === undefined) {
      throw new TokenDecryptionError();
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new TokenDecryptionError();
    }
  }

  /** True when the value was encrypted with the current key and needs no rewrap. */
  isCurrent(ciphertext: string): boolean {
    return ciphertext.split(".")[1] === this.currentId;
  }
}
