import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";
import { oauthProviderApp, handleAuthCallback } from "../src/auth/oauth-provider";
import { getSubjectProvider } from "../src/auth/identity-store";
import { getUser } from "../src/db/users";
import { OPTICAL_DONE_CATEGORY } from "../src/providers/graph-event-mapping";
import type { Env } from "../src/env";

const mockIdp: IdentityProvider = {
  scopes: ["s"],
  authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
  exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
  fetchIdentity: async () => ({ email: "operator@example.com", providerSubject: "sub-operator" }),
  refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
};

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function fullLogin(scope = "scheduler:read", clientState = "s"): Promise<string> {
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
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind(
    "codemode",
    "Code Mode",
    "pkce",
    JSON.stringify(["https://app.code-mode.example/cb"]),
    "2026-01-01T00:00:00Z",
  ).run();
  __setIdentityProviderForTests(mockIdp);
});

afterEach(() => {
  __setIdentityProviderForTests(null);
});

describe("/oauth/authorize", () => {
  it("400 on unknown client", async () => {
    const u = new URL("https://x/oauth/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", "unknown");
    u.searchParams.set("redirect_uri", "https://app.code-mode.example/cb");
    u.searchParams.set("code_challenge", "abcdef");
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("scope", "scheduler:read");
    u.searchParams.set("state", "xyz");
    const res = await SELF.fetch(u.toString());
    expect(res.status).toBe(400);
  });

  it("400 on redirect_uri not in client allowlist", async () => {
    const u = new URL("https://x/oauth/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", "codemode");
    u.searchParams.set("redirect_uri", "https://evil.example/cb");
    u.searchParams.set("code_challenge", "abcdef");
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("scope", "scheduler:read");
    u.searchParams.set("state", "xyz");
    const res = await SELF.fetch(u.toString());
    expect(res.status).toBe(400);
  });

  it("302 redirects to the upstream IdP authorize URL carrying login state", async () => {
    const u = new URL("https://x/oauth/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", "codemode");
    u.searchParams.set("redirect_uri", "https://app.code-mode.example/cb");
    u.searchParams.set("code_challenge", "Y2hhbGxlbmdl"); // base64url("challenge")
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("scope", "scheduler:read scheduler:write");
    u.searchParams.set("state", "xyz");
    const res = await SELF.fetch(u.toString(), { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc.startsWith("https://idp.test/auth?state=")).toBe(true);
  });
});

describe("/oauth/token authorization_code", () => {
  it("exchanges code+verifier for access+refresh token", async () => {
    const code = await fullLogin();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "codemode",
      redirect_uri: "https://app.code-mode.example/cb",
      code_verifier: VERIFIER,
    });
    const res = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      token_type: string; access_token: string; refresh_token: string; expires_in: number; scope: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.scope).toBe("scheduler:read");
  });

  it("rejects wrong code_verifier", async () => {
    const code = await fullLogin();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "codemode",
      redirect_uri: "https://app.code-mode.example/cb",
      code_verifier: "wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });
    const res = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    expect(res.status).toBe(400);
  });

  it("rejects reused code", async () => {
    const code = await fullLogin();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "codemode",
      redirect_uri: "https://app.code-mode.example/cb",
      code_verifier: VERIFIER,
    });
    const ok = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    expect(ok.status).toBe(200);
    const r2 = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
    });
    expect(r2.status).toBe(400);
  });

  // NOTE: This pins SEQUENTIAL single-use only — it asserts a second exchange of
  // an already-consumed code issues no tokens. It does NOT prove the atomic CAS
  // gate in oauth-provider.ts (`UPDATE ... SET used_at = ? WHERE code_hash = ?
  // AND used_at IS NULL`), because the pre-CAS code already rejected sequential
  // reuse via its `if (row.used_at)` fast-path, so this test stays green with or
  // without the fix. The CAS guards the CONCURRENT race (two simultaneous /token
  // requests both passing the `if` check before either writes used_at), which is
  // not deterministically reproducible in the vitest/Miniflare runtime — D1
  // awaits serialize single-threaded, so even `Promise.all` won't race at the DB
  // layer. Treat this as a single-use regression guard; the atomic property is
  // verified by code review, not by this test.
  it("single-use code: a second exchange issues no tokens", async () => {
    const code = await fullLogin();
    const form = () => new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "codemode",
      redirect_uri: "https://app.code-mode.example/cb",
      code_verifier: VERIFIER,
    });
    const ok = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(),
    });
    expect(ok.status).toBe(200);
    const r2 = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(),
    });
    expect(r2.status).toBe(400);
    const b2 = await r2.json() as { error: string; access_token?: string; refresh_token?: string };
    expect(b2.error).toBe("invalid_grant");
    expect(b2.access_token).toBeUndefined();
    expect(b2.refresh_token).toBeUndefined();
  });
});

describe("/oauth/token refresh_token", () => {
  it("rotates refresh token and issues new access", async () => {
    const code = await fullLogin();
    const tokRes = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "codemode",
        redirect_uri: "https://app.code-mode.example/cb",
        code_verifier: VERIFIER,
      }),
    });
    const { refresh_token } = await tokRes.json() as { refresh_token: string };

    const refRes = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: "codemode" }),
    });
    expect(refRes.status).toBe(200);
    const body = await refRes.json() as { access_token: string; refresh_token: string };
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.refresh_token).not.toBe(refresh_token);

    const reuse = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id: "codemode" }),
    });
    expect(reuse.status).toBe(400);
  });
});

describe("/oauth/revoke", () => {
  it("revokes a presented access token and is idempotent", async () => {
    // Build a token through the auth-code flow.
    const code = await fullLogin();
    const tok = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: "codemode",
        redirect_uri: "https://app.code-mode.example/cb",
        code_verifier: VERIFIER,
      }),
    });
    const { access_token } = await tok.json() as { access_token: string };

    const r = await SELF.fetch("https://x/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }),
    });
    expect(r.status).toBe(200);
    // Idempotent
    const r2 = await SELF.fetch("https://x/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access_token }),
    });
    expect(r2.status).toBe(200);

    // And the token can no longer authenticate.
    const probe = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: `Bearer ${access_token}` } });
    expect(probe.status).toBe(401);
  });
});

// A standalone app (mounted like index.ts does) so each test can pass its own
// Bindings via the third .request() arg — SELF.fetch always uses the fixed
// wrangler.toml env and can't flip MS_PROVIDER_ENABLED per test.
function makeAuthApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/oauth", oauthProviderApp);
  app.get("/auth/callback", handleAuthCallback);
  return app;
}

const MS_ENABLED_ENV = {
  ...env,
  MS_PROVIDER_ENABLED: "true",
  MICROSOFT_OAUTH_CLIENT_ID: "ms-cid",
  MICROSOFT_OAUTH_CLIENT_SECRET: "ms-secret",
};

function authorizeUrl(extra: Record<string, string> = {}): string {
  const u = new URL("https://x/oauth/authorize");
  Object.entries({
    response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "scheduler:read", state: "xyz",
    ...extra,
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

describe("/oauth/authorize provider selection", () => {
  it("placeholder Entra client id: no chooser (302 to Google) and microsoft is 400", async () => {
    // MS_PROVIDER_ENABLED=true but MICROSOFT_OAUTH_CLIENT_ID still the wrangler
    // placeholder: nobody may land on an AADSTS error page, and provider-less
    // callers keep their pre-feature 302 straight to Google.
    const placeholderEnv = { ...MS_ENABLED_ENV, MICROSOFT_OAUTH_CLIENT_ID: "<set after Entra app registration>" };
    const noProvider = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, placeholderEnv);
    expect(noProvider.status).toBe(302);
    expect(noProvider.headers.get("location")).toMatch(/^https:\/\/idp\.test\/auth\?/); // injected Google IdP
    const ms = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), {}, placeholderEnv);
    expect(ms.status).toBe(400);
    expect(await ms.json()).toEqual({ error: "unknown_provider" });
  });
  it("400 unknown_provider when microsoft is requested but the gate is off", async () => {
    const res = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_provider" });
  });

  it("302s to the Microsoft authorize endpoint when microsoft is requested and the gate is on", async () => {
    __setIdentityProviderForTests(null); // exercise the real MicrosoftIdentityProvider, not the file's mock
    const res = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), { redirect: "manual" }, MS_ENABLED_ENV);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hostname).toBe("login.microsoftonline.com");
  });

  it("200s a provider chooser with both continue-links when the gate is on and no provider is given", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), {}, MS_ENABLED_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("provider=google");
    expect(html).toContain("provider=microsoft");
    expect(html).toContain("client_id=codemode");
    expect(html).toContain("state=xyz");
    expect(html).toContain(CHALLENGE);
  });

  it("serves the chooser with no-store, noindex and frame-deny headers like sibling HTML routes", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), {}, MS_ENABLED_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("renders the chooser as a full styled document with one button per provider", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), {}, MS_ENABLED_ENV);
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<title>Sign in &middot; Optical</title>");
    expect(html).toContain("<style>");
    // one anchor per provider, carrying the provider class for the brand mark
    expect(html.match(/<a class="btn btn-google" href="\/oauth\/authorize\?[^"]*provider=google[^"]*"/)).toBeTruthy();
    expect(html.match(/<a class="btn btn-microsoft" href="\/oauth\/authorize\?[^"]*provider=microsoft[^"]*"/)).toBeTruthy();
    expect(html).toContain("<svg"); // inline brand marks, no external assets
    expect(html).not.toMatch(/src="http/);
    // query string is attribute-escaped, never raw `&`
    expect(html).not.toMatch(/href="[^"]*&(?!amp;)[^"]*"/);
  });

  it("unchanged 302 to the Google authorize endpoint when the gate is off and no provider is given", async () => {
    __setIdentityProviderForTests(null); // exercise the real GoogleIdentityProvider, not the file's mock
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, env);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hostname).toBe("accounts.google.com");
  });
});

describe("/auth/callback provider selection", () => {
  it("persists provider=microsoft on identity_tokens for a login parked with provider=microsoft", async () => {
    const authRes = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), { redirect: "manual" }, MS_ENABLED_ENV);
    const state = new URL(authRes.headers.get("location")!).searchParams.get("state")!;
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const cbRes = await makeAuthApp().request(`/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookie ? { cookie } : {} }, MS_ENABLED_ENV);
    expect(cbRes.status).toBe(302);
    expect(await getSubjectProvider(env, "operator@example.com")).toBe("microsoft");
  });

  it("redirects back with server_error (not a bare 500) when the Microsoft kill switch flips mid-login", async () => {
    const authRes = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), { redirect: "manual" }, MS_ENABLED_ENV);
    const state = new URL(authRes.headers.get("location")!).searchParams.get("state")!;
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    __setIdentityProviderForTests(null); // real factory, which throws ms_provider_disabled
    const cbRes = await makeAuthApp().request(`/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookie ? { cookie } : {} }, env); // MS_PROVIDER_ENABLED unset
    expect(cbRes.status).toBe(302);
    const loc = new URL(cbRes.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://app.code-mode.example/cb");
    expect(loc.searchParams.get("error")).toBe("server_error");
    expect(loc.searchParams.get("state")).toBe("xyz");
  });

  it("case-normalises the identity: a mixed-case UPN matches the existing lowercase Google user and triggers the switch reset", async () => {
    // Lowercase Google login first (default mockIdp → operator@example.com).
    const g = await makeAuthApp().request(authorizeUrl({ provider: "google" }), { redirect: "manual" }, MS_ENABLED_ENV);
    const gState = new URL(g.headers.get("location")!).searchParams.get("state")!;
    const gCookie = (g.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await makeAuthApp().request(`/auth/callback?code=g&state=${gState}`,
      { redirect: "manual", headers: gCookie ? { cookie: gCookie } : {} }, MS_ENABLED_ENV)).status).toBe(302);
    await env.DB.prepare("DELETE FROM calendar_sync WHERE owner_subject = ?").bind("operator@example.com").run();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token) VALUES (?,?,?)")
      .bind("operator@example.com", "primary", "CPJ-google").run();

    // Microsoft login whose IdP reports the UPN in Entra's stored casing.
    __setIdentityProviderForTests({ ...mockIdp, fetchIdentity: async () => ({ email: " Operator@Example.com ", providerSubject: "sub-operator-ms" }) });
    const m = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), { redirect: "manual" }, MS_ENABLED_ENV);
    const mState = new URL(m.headers.get("location")!).searchParams.get("state")!;
    const mCookie = (m.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const cb = await makeAuthApp().request(`/auth/callback?code=g&state=${mState}`,
      { redirect: "manual", headers: mCookie ? { cookie: mCookie } : {} }, MS_ENABLED_ENV);
    expect(cb.status).toBe(302);
    expect(new URL(cb.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    const users = await env.DB.prepare("SELECT subject FROM users").all<{ subject: string }>();
    expect(users.results.map((r) => r.subject)).toEqual(["operator@example.com"]);
    const idents = await env.DB.prepare("SELECT account_email, provider FROM identity_tokens").all<{ account_email: string; provider: string }>();
    expect(idents.results).toEqual([{ account_email: "operator@example.com", provider: "microsoft" }]);
    const sync = await env.DB.prepare("SELECT next_sync_token FROM calendar_sync WHERE owner_subject = ?")
      .bind("operator@example.com").first<{ next_sync_token: string | null }>();
    expect(sync!.next_sync_token).toBeNull(); // A2 reset fired
    const code = await env.DB.prepare("SELECT subject FROM oauth_codes").first<{ subject: string }>();
    expect(code!.subject).toBe("operator@example.com");
  });

  async function loginWithMicrosoft(): Promise<void> {
    const authRes = await makeAuthApp().request(authorizeUrl({ provider: "microsoft" }), { redirect: "manual" }, MS_ENABLED_ENV);
    const state = new URL(authRes.headers.get("location")!).searchParams.get("state")!;
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const cbRes = await makeAuthApp().request(`/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookie ? { cookie } : {} }, MS_ENABLED_ENV);
    expect(cbRes.status).toBe(302);
  }

  it("seeds done_color_id to the Optical Done category on first Microsoft sign-in", async () => {
    await loginWithMicrosoft();
    const user = await getUser(env.DB, "operator@example.com");
    expect(user?.done_color_id).toBe(OPTICAL_DONE_CATEGORY);
  });

  it("does not overwrite a pre-existing custom done_color_id on re-login", async () => {
    await loginWithMicrosoft();
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?")
      .bind("Custom Category", "operator@example.com").run();
    await loginWithMicrosoft();
    const user = await getUser(env.DB, "operator@example.com");
    expect(user?.done_color_id).toBe("Custom Category");
  });
});
