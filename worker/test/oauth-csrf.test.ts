import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";

function mock(email: string): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
    fetchIdentity: async () => ({ email, providerSubject: `sub-${email}` }),
    refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
  };
}

async function startLogin(): Promise<{ state: string; cookie: string }> {
  const u = new URL("https://x/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    scope: "scheduler:read", state: "client-state" }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await SELF.fetch(u.toString(), { redirect: "manual" });
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { state, cookie: setCookie.split(";")[0] ?? "" };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM oauth_codes").run();
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)")
    .bind("codemode", "Code Mode", "pkce", JSON.stringify(["https://app.code-mode.example/cb"]), "2026-01-01T00:00:00Z").run();
  __setIdentityProviderForTests(mock("operator@example.com"));
});
afterEach(() => __setIdentityProviderForTests(null));

describe("OAuth state ↔ cookie binding", () => {
  it("/authorize sets an HttpOnly login-nonce cookie", async () => {
    const { cookie } = await startLogin();
    expect(cookie).toMatch(/login_nonce=/);
  });

  it("completes the callback when the nonce cookie matches the state", async () => {
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: { cookie } });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("rejects the callback with HTML 400 when the nonce cookie is absent", async () => {
    const { state } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("rejects the callback with HTML 400 when the nonce cookie is for a different state", async () => {
    const first = await startLogin();      // attacker's login -> attacker's cookie
    const second = await startLogin();     // victim's login   -> victim's state
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${second.state}`,
      { redirect: "manual", headers: { cookie: first.cookie } }); // mismatched pair
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
