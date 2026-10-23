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

  // O14 #8: with neither the purpose key nor the pepper set, a resolver used
  // to return undefined and every derivation interpolated the literal string
  // "undefined" — a publicly known key. Fail closed instead.
  describe("each resolver throws when neither its key nor the pepper is set", () => {
    const cases: Array<[string, (e: any) => string, string]> = [
      ["hashingKey", hashingKey, "HASHING_KEY"],
      ["encryptionKey", encryptionKey, "ENCRYPTION_KEY"],
      ["capabilityHmacKey", capabilityHmacKey, "HMAC_KEY"],
    ];
    const envs: Array<[string, any]> = [
      ["{}", {}],
      ["both empty strings", { HASHING_KEY: "", ENCRYPTION_KEY: "", HMAC_KEY: "", TOKEN_HASH_PEPPER: "" }],
    ];
    for (const [name, fn, varName] of cases) {
      for (const [label, e] of envs) {
        it(`${name} with ${label}`, () => {
          let err: unknown;
          try { fn(e); } catch (x) { err = x; }
          expect(err).toBeInstanceOf(Error);
          const msg = (err as Error).message;
          expect(msg).toContain("crypto_key_missing");
          expect(msg).toContain(varName);
          expect(msg).toContain("TOKEN_HASH_PEPPER");
        });
      }
    }

    it("the message never carries a configured value", () => {
      // Only another purpose's key is set; the resolver under test must not echo it.
      const e = { HMAC_KEY: "secret-hmac-value", TOKEN_HASH_PEPPER: "" } as any;
      expect(() => hashingKey(e)).toThrow(/crypto_key_missing/);
      try { hashingKey(e); } catch (x) { expect((x as Error).message).not.toContain("secret-hmac-value"); }
    });
  });
});
