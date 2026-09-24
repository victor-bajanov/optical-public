import { describe, it, expect } from "vitest";
import { hashingKey, encryptionKey, capabilityHmacKey } from "../../src/auth/crypto-keys";

const base = { TOKEN_HASH_PEPPER: "pep" } as any;

describe("crypto-keys", () => {
  it("each key defaults to TOKEN_HASH_PEPPER when unset", () => {
    expect(hashingKey(base)).toBe("pep");
    expect(encryptionKey(base)).toBe("pep");
    expect(capabilityHmacKey(base)).toBe("pep");
  });

  it("each key prefers its purpose-specific value when set", () => {
    const env = { TOKEN_HASH_PEPPER: "pep", HASHING_KEY: "h", ENCRYPTION_KEY: "e", HMAC_KEY: "m" } as any;
    expect(hashingKey(env)).toBe("h");
    expect(encryptionKey(env)).toBe("e");
    expect(capabilityHmacKey(env)).toBe("m");
  });

  it("an empty-string purpose key still falls back to the pepper", () => {
    const env = { TOKEN_HASH_PEPPER: "pep", HASHING_KEY: "" } as any;
    expect(hashingKey(env)).toBe("pep");
  });
});
