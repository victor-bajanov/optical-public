import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";

const idp: IdentityProvider = {
  scopes: ["s"], authorizeUrl: ({ state }) => `https://idp.test/?state=${state}`,
  exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
  fetchIdentity: async () => ({ email: "operator@example.com", providerSubject: "sub-operator" }),
  refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
};
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function fullLogin(): Promise<string> {
  const a = new URL("https://x/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "codemode", redirect_uri: "https://app/cb",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "read", state: "cs" })
    .forEach(([k, v]) => a.searchParams.set(k, v));
  const r1 = await SELF.fetch(a.toString(), { redirect: "manual" });
  const state = new URL(r1.headers.get("location")!).searchParams.get("state")!;
  // Forward the nonce cookie set by /authorize so the CSRF check in /auth/callback passes.
  const nonceCookie = (r1.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const r2 = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
    { redirect: "manual", headers: nonceCookie ? { cookie: nonceCookie } : {} });
  const code = new URL(r2.headers.get("location")!).searchParams.get("code")!;
  const r3 = await SELF.fetch("https://x/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "codemode", redirect_uri: "https://app/cb", code_verifier: VERIFIER }),
  });
  return (await r3.json() as { access_token: string }).access_token;
}

beforeEach(async () => {
  for (const t of ["oauth_codes", "oauth_tokens", "oauth_clients", "identity_tokens"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES (?,?,?,?,?,?)")
    .bind("codemode", "Code Mode", "pkce", JSON.stringify(["https://app/cb"]), "read", "2026-01-01T00:00:00Z").run();
  __setIdentityProviderForTests(idp);
});
afterEach(() => __setIdentityProviderForTests(null));

describe("subject flow", () => {
  it("stamps subject on the issued token and userinfo returns sub=subject", async () => {
    const token = await fullLogin();
    const row = await env.DB.prepare("SELECT subject FROM oauth_tokens WHERE refresh_of IS NULL").first<{ subject: string }>();
    expect(row!.subject).toBe("operator@example.com");
    const ui = await SELF.fetch("https://x/oauth/userinfo", { headers: { authorization: `Bearer ${token}` } });
    const body = await ui.json() as { sub: string; email?: string };
    expect(body.sub).toBe("operator@example.com");
  });
});
