import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher, TokenDecryptionError, parseEncryptionKey } from "./token-cipher.js";

const key = () => randomBytes(32);

describe("TokenCipher", () => {
  it("round-trips a value bound to its context", () => {
    const cipher = new TokenCipher(key());
    const sealed = cipher.encrypt("refresh-token-fixture", "oauth_accounts:personal");
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(sealed).not.toContain("refresh-token-fixture");
    expect(cipher.decrypt(sealed, "oauth_accounts:personal")).toBe("refresh-token-fixture");
    expect(cipher.encrypt("same", "ctx")).not.toBe(cipher.encrypt("same", "ctx"));
  });

  it("detects tampering, a wrong context and an unknown key", () => {
    const cipher = new TokenCipher(key());
    const sealed = cipher.encrypt("secret", "ctx");
    const parts = sealed.split(".");
    const data = Buffer.from(parts[4] as string, "base64url");
    data[0] = (data[0] as number) ^ 0xff;
    const tampered = [...parts.slice(0, 4), data.toString("base64url")].join(".");

    expect(() => cipher.decrypt(tampered, "ctx")).toThrow(TokenDecryptionError);
    expect(() => cipher.decrypt(sealed, "other-ctx")).toThrow(TokenDecryptionError);
    expect(() => new TokenCipher(key()).decrypt(sealed, "ctx")).toThrow(TokenDecryptionError);
    expect(() => cipher.decrypt("garbage", "ctx")).toThrow(TokenDecryptionError);
  });

  it("decrypts with the previous key during rotation and flags stale values", () => {
    const oldKey = key();
    const sealed = new TokenCipher(oldKey).encrypt("secret", "ctx");
    const rotated = new TokenCipher(key(), oldKey);
    expect(rotated.isCurrent(sealed)).toBe(false);
    expect(rotated.decrypt(sealed, "ctx")).toBe("secret");
    expect(rotated.isCurrent(rotated.encrypt("secret", "ctx"))).toBe(true);
  });

  it("validates key length without echoing the key", () => {
    const short = Buffer.from("too short").toString("base64");
    expect(() => parseEncryptionKey(short, "TOKEN_ENCRYPTION_KEY")).toThrow(/TOKEN_ENCRYPTION_KEY must be 32 bytes/);
    try {
      parseEncryptionKey(short, "TOKEN_ENCRYPTION_KEY");
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
    expect(TokenCipher.fromEnv({})).toBeUndefined();
    expect(TokenCipher.fromEnv({ TOKEN_ENCRYPTION_KEY: key().toString("base64") })).toBeInstanceOf(TokenCipher);
  });
});
