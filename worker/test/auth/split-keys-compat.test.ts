import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { storeIdentityTokens, getAccessToken } from "../../src/auth/identity-store";
import { __setIdentityProviderForTests } from "../../src/auth/identity-provider";
import type { IdentityProvider } from "../../src/auth/identity-provider";
import { signCapabilityWithEnv, verifyCapabilityWithEnv, signCapability, verifyCapability } from "../../src/auth/capability";

function idp(): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: () => "https://idp.test",
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
    fetchIdentity: async () => ({ email: "u@org", providerSubject: "sub-u@org" }),
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
    await env.GOOGLE_TOKEN_CACHE.delete("idp_access_token:u@org"); // force a DB read + decrypt
    const token = await getAccessToken(env, idp(), "u@org", { forceRefresh: true });
    expect(token).toBe("fresh");
  });
});

describe("capability HMAC wrappers use capabilityHmacKey(env)", () => {
  const payload = { planHash: "abc123", subject: "u@org", purpose: "accept" as const, ttlSeconds: 3600 };

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
