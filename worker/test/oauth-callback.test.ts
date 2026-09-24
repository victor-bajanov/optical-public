import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";

function mock(email: string, opts: { exchangeThrows?: boolean } = {}): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
    exchangeCode: async () => {
      if (opts.exchangeThrows) throw new Error("upstream exchange failed");
      return { accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" };
    },
    fetchIdentity: async () => ({ email, providerSubject: `sub-${email}` }),
    refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
  };
}

// Like mock(), but the providerSubject is fixed rather than derived from the
// email — lets a test simulate the same IdP identity returning under a
// different email (a rename), which is exactly the case resolveSubject exists
// for (G6).
function mockWithFixedSubject(email: string, providerSubject: string): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
    fetchIdentity: async () => ({ email, providerSubject }),
    refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
  };
}

async function startLogin(): Promise<{ state: string; cookie: string | null }> {
  const u = new URL("https://x/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    scope: "scheduler:read", state: "client-state" }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await SELF.fetch(u.toString(), { redirect: "manual" });
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: res.headers.get("set-cookie") };
}

// Forward-compatible scaffolding for Task 10 CSRF binding: re-send the nonce
// cookie set by /authorize on the callback so the CSRF check can verify it.
// The authorize handler sets no cookie today, so setCookie is always null and
// this returns {}. The plumbing is intentionally inert until Task 10 wires up
// the Set-Cookie header on /authorize.
function cookieHeader(setCookie: string | null): Record<string, string> {
  if (!setCookie) return {};
  const pair = setCookie.split(";")[0]!;
  return { cookie: pair };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM oauth_codes").run();
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)")
    .bind("codemode", "Code Mode", "pkce", JSON.stringify(["https://app.code-mode.example/cb"]), "2026-01-01T00:00:00Z").run();
});
afterEach(() => __setIdentityProviderForTests(null));

describe("/auth/callback", () => {
  it("mints a code and seeds an admin user for an OPERATOR_EMAIL identity", async () => {
    __setIdentityProviderForTests(mock("operator@example.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("code")).toBeTruthy();
    const row = await env.DB.prepare("SELECT account_email FROM identity_tokens").first<{ account_email: string }>();
    expect(row!.account_email).toBe("operator@example.com");
    const user = await env.DB.prepare("SELECT role, is_active FROM users WHERE subject = ?")
      .bind("operator@example.com").first<{ role: string; is_active: number }>();
    expect(user).toEqual({ role: "admin", is_active: 1 });
  });

  it("mints a code for a pre-seeded active member and keeps their member role", async () => {
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
      .bind("member@example.com", "member", 1, "2026-01-01T00:00:00Z").run();
    __setIdentityProviderForTests(mock("member@example.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("error")).toBeNull();
    expect(loc.searchParams.get("code")).toBeTruthy();
    const user = await env.DB.prepare("SELECT role FROM users WHERE subject = ?")
      .bind("member@example.com").first<{ role: string }>();
    expect(user!.role).toBe("member");
  });

  it("a renamed member (same providerSubject, new email not on the allow-list) completes login; the minted code's subject is the ORIGINAL email", async () => {
    // Prior login: old@example.com, provider google, providerSubject fixed-sub.
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
      .bind("old@example.com", "member", 1, "2026-01-01T00:00:00Z").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind("old@example.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "fixed-sub").run();

    // Same IdP identity (providerSubject unchanged), new email that is NOT
    // allow-listed and doesn't match OPERATOR_EMAIL.
    __setIdentityProviderForTests(mockWithFixedSubject("new-not-allowlisted@evil.com", "fixed-sub"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBeNull();
    expect(loc.searchParams.get("code")).toBeTruthy();

    // No second identity_tokens row created for the new email.
    const rows = await env.DB.prepare("SELECT account_email FROM identity_tokens").all<{ account_email: string }>();
    expect(rows.results.map((r) => r.account_email)).toEqual(["old@example.com"]);

    const code = await env.DB.prepare("SELECT subject FROM oauth_codes").first<{ subject: string }>();
    expect(code!.subject).toBe("old@example.com");
  });

  it("a brand-new non-member is still access_denied even though fetchIdentity now also returns a providerSubject", async () => {
    __setIdentityProviderForTests(mockWithFixedSubject("stranger@evil.com", "brand-new-sub"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("redirects with access_denied (no code, no identity, no user) for a non-member", async () => {
    __setIdentityProviderForTests(mock("intruder@evil.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("renders an HTML 400 when the login state is missing/expired", async () => {
    __setIdentityProviderForTests(mock("operator@example.com"));
    const res = await SELF.fetch("https://x/auth/callback?code=g&state=bogus", { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("redirects with server_error (no code) when the IdP exchange fails", async () => {
    __setIdentityProviderForTests(mock("operator@example.com", { exchangeThrows: true }));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("error")).toBe("server_error");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("logs the underlying failure when it answers server_error (never a silent swallow)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      __setIdentityProviderForTests(mock("operator@example.com", { exchangeThrows: true }));
      const { state, cookie } = await startLogin();
      await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
        { redirect: "manual", headers: cookieHeader(cookie) });
      const line = spy.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("auth_callback_failed"));
      expect(line).toBeDefined();
      expect(line).toContain("provider=google");
      expect(line).toContain("exchange failed"); // the mock's thrown message survives
    } finally {
      spy.mockRestore();
    }
  });
});
