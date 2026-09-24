import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";

const mockIdp: IdentityProvider = {
  scopes: ["s"],
  authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
  exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
  fetchIdentity: async () => ({ email: "operator@example.com", providerSubject: "sub-operator" }),
  refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
};

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function fullLogin(scope: string, clientState = "s"): Promise<string> {
  const a = new URL("https://x/oauth/authorize");
  Object.entries({
    response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope, state: clientState,
  }).forEach(([k, v]) => a.searchParams.set(k, v));
  const r1 = await SELF.fetch(a.toString(), { redirect: "manual" });
  const state = new URL(r1.headers.get("location")!).searchParams.get("state")!;
  // Forward the nonce cookie set by /authorize so the CSRF check in /auth/callback passes.
  const nonceCookie = (r1.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const r2 = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
    { redirect: "manual", headers: nonceCookie ? { cookie: nonceCookie } : {} });
  return new URL(r2.headers.get("location")!).searchParams.get("code")!;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM oauth_codes").run();
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES (?,?,?,?,?,?)",
  ).bind(
    "codemode",
    "Code Mode",
    "pkce",
    JSON.stringify(["https://app.code-mode.example/cb"]),
    "read write",
    "2026-01-01T00:00:00Z",
  ).run();
  __setIdentityProviderForTests(mockIdp);
});

afterEach(() => {
  __setIdentityProviderForTests(null);
});

describe("/oauth/token authorization_code with extraneous client_secret", () => {
  it("accepts (and ignores) client_secret for a pkce client", async () => {
    // 1. Drive a full federated login to obtain a one-shot code.
    const code = await fullLogin("read write");

    // 2. Exchange the code with a (deliberately invalid) client_secret field.
    //    For a pkce client the secret is ignored; the verifier is what matters.
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "codemode",
      client_secret: "ignored-by-the-server",
      redirect_uri: "https://app.code-mode.example/cb",
      code_verifier: VERIFIER,
    });
    const res = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
