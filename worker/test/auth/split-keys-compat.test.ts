import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  storeIdentityTokens, getAccessToken, accessCacheKey, readCachedAccessToken, dropCachedAccessToken,
} from "../../src/auth/identity-store";
import type { Env } from "../../src/env";
import { hashToken } from "../../src/auth/tokens";
import { decryptString } from "../../src/auth/encryption";
import { __setIdentityProviderForTests } from "../../src/auth/identity-provider";
import type { IdentityProvider } from "../../src/auth/identity-provider";
import { signCapabilityWithEnv, verifyCapabilityWithEnv, signCapability, verifyCapability } from "../../src/auth/capability";

function idp(): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: () => "https://idp.test",
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
    fetchIdentity: async () => ({ email: "u@org", providerSubject: "sub-u@org" }),
    revokeGrant: async () => {},
    refreshAccessToken: async () => ({ accessToken: "fresh", expiresIn: 3600 }),
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
});

describe("split-key encryption round-trips with ENCRYPTION_KEY defaulting to pepper", () => {
  it("stores then decrypts the refresh token using the resolved encryption key", async () => {
    await storeIdentityTokens(env, "u@org", { refreshToken: "the-refresh", accessToken: "a", expiresIn: 3600, scope: "s" });
    await dropCachedAccessToken(env, "u@org"); // force a DB read + decrypt
    const token = await getAccessToken(env, idp(), "u@org", { forceRefresh: true });
    expect(token).toBe("fresh");
  });
});

describe("access-token cache under split HASHING_KEY / ENCRYPTION_KEY (dev splits its secrets)", () => {
  const split = () => ({
    ...env, HASHING_KEY: "split-hashing-key-not-the-pepper", ENCRYPTION_KEY: "split-encryption-key-not-the-pepper",
  }) as Env;

  it("round-trips: the sign-in's cached token reads back and getAccessToken serves it without a refresh", async () => {
    const e = split();
    await storeIdentityTokens(e, "u@org", { refreshToken: "the-refresh", accessToken: "AT-split", expiresIn: 3600, scope: "s" });
    expect(await readCachedAccessToken(e, "u@org")).toBe("AT-split");
    expect(await getAccessToken(e, { ...idp(), refreshAccessToken: async () => { throw new Error("must not refresh"); } }, "u@org")).toBe("AT-split");
  });

  it("the key name is hashed under HASHING_KEY, not TOKEN_HASH_PEPPER", async () => {
    const e = split();
    const key = await accessCacheKey(e, "u@org");
    expect(key).toBe(`idp_at:${await hashToken("idp-access:u@org", e.HASHING_KEY!)}`);
    expect(key).not.toBe(`idp_at:${await hashToken("idp-access:u@org", e.TOKEN_HASH_PEPPER)}`);
  });

  it("the stored value does not decrypt under the identity-refresh purpose (domain separation)", async () => {
    const e = split();
    await storeIdentityTokens(e, "u@org", { refreshToken: "the-refresh", accessToken: "AT-split", expiresIn: 3600, scope: "s" });
    const raw = await e.GOOGLE_TOKEN_CACHE.get(await accessCacheKey(e, "u@org"), "arrayBuffer");
    expect(raw).not.toBeNull();
    await expect(decryptString(raw!, e.ENCRYPTION_KEY!, "identity-refresh")).rejects.toThrow();
    expect(await decryptString(raw!, e.ENCRYPTION_KEY!, "identity-access")).toBe("AT-split");
  });
});

describe("capability HMAC wrappers use capabilityHmacKey(env)", () => {
  const payload = { planHash: "abc123", subject: "u@org", purpose: "accept" as const, ttlSeconds: 3600, anchor: "test-anchor" };

  it("signCapabilityWithEnv + verifyCapabilityWithEnv round-trip using env key", async () => {
    const token = await signCapabilityWithEnv(payload, env);
    const claims = await verifyCapabilityWithEnv(token, env);
    expect(claims).not.toBeNull();
    expect(claims?.subject).toBe("u@org");
    expect(claims?.planHash).toBe("abc123");
    expect(claims?.purpose).toBe("accept");
  });

  it("token signed with a different HMAC key is rejected by verifyCapabilityWithEnv", async () => {
    // Sign with a key that differs from TOKEN_HASH_PEPPER (the default used by env)
    const tokenWithWrongKey = await signCapability(payload, "different-secret-key");
    const claims = await verifyCapabilityWithEnv(tokenWithWrongKey, env);
    expect(claims).toBeNull();
  });

  it("token signed via signCapabilityWithEnv is rejected when verified with a different key", async () => {
    const token = await signCapabilityWithEnv(payload, env);
    // Verify with a different pepper to confirm the env key is actually in use
    const claims = await verifyCapability(token, "different-secret-key");
    expect(claims).toBeNull();
  });
});
