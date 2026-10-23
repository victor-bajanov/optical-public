import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import { oauthProviderApp, handleAuthCallback } from "../src/auth/oauth-provider";
import type { Env } from "../src/env";
import type { IdentityProvider } from "../src/auth/identity-provider";
import { FULL_UPSTREAM_GRANT } from "./fixtures/upstream-grant";
import { __setSignInSubscriberForTests, ensureSubscriptionOnSignIn } from "../src/webhooks/sign-in-subscribe";
import { MockCalendarProvider } from "../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../src/db/calendar-sync";

function mock(email: string, opts: { exchangeThrows?: boolean } = {}): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
    exchangeCode: async () => {
      if (opts.exchangeThrows) throw new Error("upstream exchange failed");
      return { accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: FULL_UPSTREAM_GRANT };
    },
    fetchIdentity: async () => ({ email, providerSubject: `sub-${email}` }),
    revokeGrant: async () => {},
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
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: FULL_UPSTREAM_GRANT }),
    fetchIdentity: async () => ({ email, providerSubject }),
    revokeGrant: async () => {},
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

  it("O10b: an OPERATOR_EMAIL admin sign-in records activity and clears a retention warning", async () => {
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at, retention_warned_at) VALUES (?,?,?,?,?,?)")
      .bind("operator@example.com", "admin", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00.000Z").run();
    __setIdentityProviderForTests(mock("operator@example.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    const user = await env.DB.prepare("SELECT role, is_active, last_seen, retention_warned_at FROM users WHERE subject = ?")
      .bind("operator@example.com").first<{ role: string; is_active: number; last_seen: string | null; retention_warned_at: string | null }>();
    expect(user).toMatchObject({ role: "admin", is_active: 1, retention_warned_at: null });
    expect(user!.last_seen).not.toBe("2026-01-01T00:00:00.000Z");
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

  it("a brand-new non-member is still refused even though fetchIdentity now also returns a providerSubject", async () => {
    __setIdentityProviderForTests(mockWithFixedSubject("stranger@evil.com", "brand-new-sub"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("O4: a non-member gets a 403 invitation-only HTML page, no redirect, no code, no identity, no user", async () => {
    __setIdentityProviderForTests(mock("intruder@evil.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toMatch(/invitation-only/i);
    expect(html).not.toContain("client-state");
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

// O4 with env overrides (revoke flag, INVITE_CONTACT, allow-list): drive the
// same routes through a local Hono app so each test picks its own bindings.
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/oauth", oauthProviderApp);
  app.get("/auth/callback", handleAuthCallback);
  return app;
}

async function refusedCallback(e: Env, idp: IdentityProvider, provider: "google" | "microsoft" = "google"): Promise<Response> {
  __setIdentityProviderForTests(idp);
  const app = makeApp();
  const u = new URL("https://x/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    scope: "scheduler:read", state: "client-state", provider }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r1 = await app.request(u.toString(), { redirect: "manual" }, e);
  const state = new URL(r1.headers.get("location")!).searchParams.get("state")!;
  return app.request(`https://x/auth/callback?code=g&state=${state}`,
    { redirect: "manual", headers: cookieHeader(r1.headers.get("set-cookie")) }, e);
}

function revokingMock(email: string, tokens: { refreshToken?: string } = { refreshToken: "upstream-refresh-SECRET" }) {
  const revokeGrant = vi.fn(async (_t: string) => {});
  const idp: IdentityProvider = {
    ...mock(email),
    exchangeCode: async () => ({ accessToken: "upstream-access-SECRET", ...tokens, expiresIn: 3600, scope: FULL_UPSTREAM_GRANT }),
    revokeGrant,
  };
  return { idp, revokeGrant };
}

describe("/auth/callback non-member (O4)", () => {
  it("UPSTREAM_REVOKE_ENABLED=true: revokes the just-received grant once (refresh token preferred), never logging it", async () => {
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    try {
      const { idp, revokeGrant } = revokingMock("intruder@evil.com");
      const res = await refusedCallback({ ...env, UPSTREAM_REVOKE_ENABLED: "true" } as Env, idp);
      expect(res.status).toBe(403);
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(revokeGrant).toHaveBeenCalledWith("upstream-refresh-SECRET");
      const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => c.map((a) => JSON.stringify(a)).join(" "));
      expect(lines.some((l) => l.includes("SECRET"))).toBe(false);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("falls back to the access token when the IdP returned no refresh token", async () => {
    const { idp, revokeGrant } = revokingMock("intruder@evil.com", {});
    await refusedCallback({ ...env, UPSTREAM_REVOKE_ENABLED: "true" } as Env, idp);
    expect(revokeGrant).toHaveBeenCalledWith("upstream-access-SECRET");
  });

  it("flag off: never calls revokeGrant, still 403", async () => {
    const { idp, revokeGrant } = revokingMock("intruder@evil.com");
    const res = await refusedCallback({ ...env, UPSTREAM_REVOKE_ENABLED: "false" } as Env, idp);
    expect(res.status).toBe(403);
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it("a failing upstream revoke still renders the 403 page and stores nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { idp } = revokingMock("intruder@evil.com");
      idp.revokeGrant = async () => { throw new Error("revoke 500"); };
      const res = await refusedCallback({ ...env, UPSTREAM_REVOKE_ENABLED: "true" } as Env, idp);
      expect(res.status).toBe(403);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens").first<{ n: number }>()).toMatchObject({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()).toMatchObject({ n: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("renders INVITE_CONTACT (escaped) and DEPLOYMENT_LABEL on the page", async () => {
    const { idp } = revokingMock("intruder@evil.com");
    const res = await refusedCallback({ ...env, INVITE_CONTACT: "the <ops> team", DEPLOYMENT_LABEL: "Trial" } as Env, idp);
    const html = await res.text();
    expect(html).toContain("Ask the &lt;ops&gt; team for an invite.");
    expect(html).toContain('<span class="badge">Trial</span>');
  });

  it("allow-list mode: an active users row NOT on the allow-list is refused with the 403 page", async () => {
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
      .bind("delisted@example.com", "member", 1, "2026-01-01T00:00:00Z").run();
    const { idp } = revokingMock("delisted@example.com");
    const res = await refusedCallback({ ...env, MEMBERSHIP_ALLOWLIST: "someone-else@example.com" } as Env, idp);
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens").first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

// O6: granular consent fails closed. Google lets a person untick individual
// permissions; the token response's `scope` then lacks them. The callback
// checks it BEFORE fetchIdentity, revokes, stores nothing and shows a 403 page.
const G = "https://www.googleapis.com/auth/";
const GRAPH = "https://graph.microsoft.com/";
const PARTIAL: Record<"google" | "microsoft", { grant: string; label: string; kept: string }> = {
  // gmail.send unticked; calendar.events/freebusy granted.
  google: {
    grant: `openid ${G}userinfo.email ${G}calendar.events ${G}calendar.freebusy`,
    label: "Send email on your behalf",
    kept: "View and edit events on your calendars",
  },
  // Mail.Send unticked; Calendars.ReadWrite granted.
  microsoft: {
    grant: `${GRAPH}Calendars.ReadWrite openid profile email offline_access`,
    label: "Send mail as you",
    kept: "Have full access to your calendars",
  },
};

function grantingMock(email: string, scope: string | undefined) {
  const revokeGrant = vi.fn(async (_t: string) => {});
  const fetchIdentity = vi.fn(async () => ({ email, providerSubject: `sub-${email}` }));
  const idp: IdentityProvider = {
    ...mock(email),
    exchangeCode: async () => ({
      accessToken: "upstream-access-SECRET", refreshToken: "upstream-refresh-SECRET", expiresIn: 3600,
      scope: scope as string,
    }),
    fetchIdentity,
    revokeGrant,
  };
  return { idp, revokeGrant, fetchIdentity };
}

const o6Env = (over: Partial<Env> = {}) => ({
  ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "entra-client-id",
  UPSTREAM_REVOKE_ENABLED: "true", ...over,
} as Env);

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["oauth_codes", "identity_tokens", "users"]) {
    out[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  }
  return out;
}

for (const provider of ["google", "microsoft"] as const) {
  describe(`/auth/callback partial grant (O6, ${provider})`, () => {
    it("refuses with a 403 HTML page naming the unticked permission; revokes once; stores nothing; never resolves identity", async () => {
      // An OPERATOR_EMAIL identity: membership would pass, so the scope gate
      // is the only thing that can refuse.
      const { idp, revokeGrant, fetchIdentity } = grantingMock("operator@example.com", PARTIAL[provider].grant);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      const html = await res.text();
      expect(html).toContain("Permissions needed");
      expect(html).toMatch(/needs all of the permissions/);
      expect(html).toContain(`<li>${PARTIAL[provider].label}</li>`);
      expect(html).not.toContain(PARTIAL[provider].kept);
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(revokeGrant).toHaveBeenCalledWith("upstream-refresh-SECRET");
      expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
    });

    it("partial grant from an identity that already holds a stored grant (same provider): 403, never revokes, stored grant untouched, logs auth_callback_revoke_skipped without email or token", async () => {
      // Revoking would kill the member's EXISTING grant too (Google revokes
      // the whole user-app grant), so a re-consent with a box unticked must
      // leave it alone.
      await env.DB.prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
      ).bind("member@example.com", new Uint8Array([7, 7, 7]).buffer, "s", "2026-01-01T00:00:00Z", provider, "sub-member@example.com").run();
      await env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?,?,?,?,?)")
        .bind("member@example.com", "member", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00Z").run();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // The token's email is mixed-case: hasStoredGrant sees it normalised.
        const { idp, revokeGrant } = grantingMock("Member@Example.com", PARTIAL[provider].grant);
        idp.fetchIdentity = vi.fn(async () => ({ email: "Member@Example.com", providerSubject: "sub-member@example.com" }));
        const res = await refusedCallback(o6Env(), idp, provider);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("Permissions needed");
        expect(revokeGrant).not.toHaveBeenCalled();
        const row = await env.DB.prepare("SELECT refresh_token_encrypted, updated_at FROM identity_tokens WHERE account_email = ?")
          .bind("member@example.com").first<{ refresh_token_encrypted: ArrayBuffer; updated_at: string }>();
        expect([...new Uint8Array(row!.refresh_token_encrypted)]).toEqual([7, 7, 7]);
        expect(row!.updated_at).toBe("2026-01-01T00:00:00Z");
        expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 1, users: 1 });
        const user = await env.DB.prepare("SELECT last_seen FROM users WHERE subject = ?")
          .bind("member@example.com").first<{ last_seen: string }>();
        expect(user!.last_seen).toBe("2026-01-01T00:00:00.000Z");
        const lines = warn.mock.calls.map((c) => c.map((a) => JSON.stringify(a)).join(" "));
        const skipped = lines.find((l) => l.includes("auth_callback_revoke_skipped"));
        expect(skipped).toBeDefined();
        expect(skipped).toContain(provider);
        expect(skipped).toContain("existing_grant");
        expect(skipped!.toLowerCase()).not.toContain("member@example.com");
        expect(lines.some((l) => l.includes("SECRET"))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it("stored grant exists but under the OTHER provider: still revokes once", async () => {
      const other = provider === "google" ? "microsoft" : "google";
      await env.DB.prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
      ).bind("operator@example.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", other, "other-sub").run();
      const { idp, revokeGrant } = grantingMock("operator@example.com", PARTIAL[provider].grant);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(403);
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(revokeGrant).toHaveBeenCalledWith("upstream-refresh-SECRET");
    });

    it("fetchIdentity throws on a partial grant: still revokes once, still 403, stores nothing", async () => {
      const { idp, revokeGrant } = grantingMock("operator@example.com", PARTIAL[provider].grant);
      idp.fetchIdentity = async () => { throw new Error("userinfo 500"); };
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Permissions needed");
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
    });

    it("links 'Try again' to a same-origin /oauth/authorize carrying the client's original params (no provider, so the chooser shows again)", async () => {
      const { idp } = grantingMock("operator@example.com", PARTIAL[provider].grant);
      const html = await (await refusedCallback(o6Env(), idp, provider)).text();
      const href = /<a class="btn" href="([^"]+)">Try again<\/a>/.exec(html)?.[1];
      expect(href).toBeDefined();
      const decoded = href!.replace(/&amp;/g, "&");
      expect(decoded.startsWith("/oauth/authorize?")).toBe(true);
      const q = new URL(decoded, "https://x").searchParams;
      expect(Object.fromEntries(q)).toEqual({
        response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
        scope: "scheduler:read", state: "client-state",
      });
      // The link is a live restart: /authorize re-validates it and renders the
      // chooser (two providers offered in this env).
      const again = await makeApp().request(`https://x${decoded}`, { redirect: "manual" }, o6Env());
      expect(again.status).toBe(200);
      expect(await again.text()).toContain("provider=google");
    });

    it("UPSTREAM_REVOKE_ENABLED off: still refused, revokeGrant never called, fetchIdentity never called", async () => {
      const { idp, revokeGrant, fetchIdentity } = grantingMock("operator@example.com", PARTIAL[provider].grant);
      const res = await refusedCallback(o6Env({ UPSTREAM_REVOKE_ENABLED: "false" }), idp, provider);
      expect(res.status).toBe(403);
      expect(revokeGrant).not.toHaveBeenCalled();
      expect(fetchIdentity).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
    });

    it("a token response with no scope field fails closed", async () => {
      const { idp } = grantingMock("operator@example.com", undefined);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(403);
      expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
    });

    it("logs which scopes were missing, never a token", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { idp } = grantingMock("operator@example.com", PARTIAL[provider].grant);
        await refusedCallback(o6Env(), idp, provider);
        const lines = warn.mock.calls.map((c) => c.map((a) => JSON.stringify(a)).join(" "));
        const line = lines.find((l) => l.includes("auth_callback_missing_scopes"));
        expect(line).toBeDefined();
        expect(line).toContain(provider);
        expect(line).toMatch(provider === "google" ? /gmail\.send/ : /mail\.send/);
        expect(lines.some((l) => l.includes("SECRET"))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it("a full grant passes: 302 back to the client with a code, no revoke", async () => {
      const { idp, revokeGrant } = grantingMock("operator@example.com", FULL_UPSTREAM_GRANT);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("code")).toBeTruthy();
      expect(loc.searchParams.get("state")).toBe("client-state");
      expect(revokeGrant).not.toHaveBeenCalled();
      const row = await env.DB.prepare("SELECT provider FROM identity_tokens").first<{ provider: string }>();
      expect(row!.provider).toBe(provider);
    });
  });
}

describe("/auth/callback harness scopes (O6)", () => {
  it("GOOGLE_ACL_SCOPE_ENABLED=true and calendar.acls unticked: refused, naming it", async () => {
    const grant = `${G}calendar.events ${G}calendar.freebusy ${G}gmail.send`;
    const { idp } = grantingMock("operator@example.com", grant);
    const res = await refusedCallback(o6Env({ GOOGLE_ACL_SCOPE_ENABLED: "true" }), idp, "google");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("sharing permissions");
  });

  it("harness flag off: the same grant passes", async () => {
    const grant = `${G}calendar.events ${G}calendar.freebusy ${G}gmail.send`;
    const { idp } = grantingMock("operator@example.com", grant);
    const res = await refusedCallback(o6Env({ GOOGLE_ACL_SCOPE_ENABLED: "false" }), idp, "google");
    expect(res.status).toBe(302);
  });

  it("MICROSOFT_MAIL_READ_SCOPE_ENABLED=true and Mail.Read missing: refused", async () => {
    const { idp } = grantingMock("operator@example.com", "Calendars.ReadWrite Mail.Send");
    const res = await refusedCallback(o6Env({ MICROSOFT_MAIL_READ_SCOPE_ENABLED: "true" }), idp, "microsoft");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Read your mail");
  });
});

// Decision D (trial): REFUSE_PROVIDER_REBIND exactly "true" refuses a sign-in
// whose email resolves to an account already bound to a DIFFERENT IdP
// identity (another subject at the same IdP, or the other IdP). Store nothing,
// touch no row, revoke the just-received grant best-effort, and show a
// terminal account_bound page. Order: scope check (O6) -> identity ->
// membership (O4) -> rebind refusal -> store.
const rebindEnv = (over: Partial<Env> = {}) => o6Env({ REFUSE_PROVIDER_REBIND: "true", INVITE_CONTACT: "the trial admin", ...over });

async function seedBoundAccount(email: string, provider: string, providerSubject: string | null) {
  await env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
  ).bind(email, new Uint8Array([7, 7, 7]).buffer, "stored", "2026-01-01T00:00:00Z", provider, providerSubject).run();
  await env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at, done_color_id) VALUES (?,?,?,?,?,?)")
    .bind(email, "member", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00Z", "11").run();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(email, "primary", "SYNC-TOKEN", "chan-1", "tok-1", "2027-01-01T00:00:00Z", "res-1", "https://x/cb").run();
}

async function accountSnapshot(email: string) {
  return {
    tokens: await env.DB.prepare("SELECT hex(refresh_token_encrypted) AS enc, scopes, updated_at, provider, provider_subject FROM identity_tokens WHERE account_email = ?").bind(email).first(),
    user: await env.DB.prepare("SELECT role, is_active, last_seen, done_color_id, retention_warned_at FROM users WHERE subject = ?").bind(email).first(),
    sync: await env.DB.prepare("SELECT next_sync_token, channel_id FROM calendar_sync WHERE owner_subject = ?").bind(email).first(),
    counts: await counts(),
  };
}

function identityMock(email: string, providerSubject: string, scope: string = FULL_UPSTREAM_GRANT) {
  const g = grantingMock(email, scope);
  g.idp.fetchIdentity = vi.fn(async () => ({ email, providerSubject }));
  return g;
}

for (const provider of ["google", "microsoft"] as const) {
  const other = provider === "google" ? "microsoft" : "google";

  describe(`/auth/callback REFUSE_PROVIDER_REBIND (D, ${provider})`, () => {
    beforeEach(async () => { await env.DB.prepare("DELETE FROM calendar_sync").run(); });

    it("a different account at the same IdP with the bound email: 403 account_bound, revoked once, nothing written, logs without email or token", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const before = await accountSnapshot("member@example.com");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { idp, revokeGrant } = identityMock("member@example.com", "intruder-sub");
        const res = await refusedCallback(rebindEnv(), idp, provider);
        expect(res.status).toBe(403);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("x-robots-tag")).toBe("noindex");
        const html = await res.text();
        expect(html).toContain("Account already linked");
        expect(html).toContain("ask the trial admin for help");
        expect(html).not.toContain("client-state");
        expect(revokeGrant).toHaveBeenCalledTimes(1);
        expect(revokeGrant).toHaveBeenCalledWith("upstream-refresh-SECRET");
        expect(await accountSnapshot("member@example.com")).toEqual(before);
        expect(await env.GOOGLE_TOKEN_CACHE.get("idp_access_token:member@example.com")).toBeNull();
        const lines = warn.mock.calls.map((c) => c.map((a) => JSON.stringify(a)).join(" "));
        const line = lines.find((l) => l.includes("auth_callback_rebind_refused"));
        expect(line).toBeDefined();
        expect(line).toContain(provider);
        expect(line).toContain("subject");
        expect(line!.toLowerCase()).not.toContain("member@example.com");
        expect(line).not.toContain("intruder-sub");
        expect(lines.some((l) => l.includes("SECRET"))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it(`the same email at the OTHER IdP (${other} bound): 403 account_bound, no provider-switch reset`, async () => {
      await seedBoundAccount("member@example.com", other, "owner-sub");
      const before = await accountSnapshot("member@example.com");
      const { idp, revokeGrant } = identityMock("member@example.com", "new-idp-sub");
      const res = await refusedCallback(rebindEnv(), idp, provider);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Account already linked");
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(await accountSnapshot("member@example.com")).toEqual(before);
    });

    it("UPSTREAM_REVOKE_ENABLED off: still refused, revokeGrant never called", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const { idp, revokeGrant } = identityMock("member@example.com", "intruder-sub");
      const res = await refusedCallback(rebindEnv({ UPSTREAM_REVOKE_ENABLED: "false" }), idp, provider);
      expect(res.status).toBe(403);
      expect(revokeGrant).not.toHaveBeenCalled();
    });

    it("the bound identity itself signs in: 302 with a code", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const { idp, revokeGrant } = identityMock("member@example.com", "owner-sub");
      const res = await refusedCallback(rebindEnv(), idp, provider);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
      expect(revokeGrant).not.toHaveBeenCalled();
    });

    it("the bound identity under a renamed email (provider_subject match): 302, code subject is the original email", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const { idp } = identityMock("renamed@example.com", "owner-sub");
      const res = await refusedCallback(rebindEnv(), idp, provider);
      expect(res.status).toBe(302);
      const code = await env.DB.prepare("SELECT subject FROM oauth_codes").first<{ subject: string }>();
      expect(code!.subject).toBe("member@example.com");
    });

    it("a legacy row with NULL provider_subject still binds (backfilled)", async () => {
      await seedBoundAccount("member@example.com", provider, null);
      const { idp } = identityMock("member@example.com", "first-sub");
      const res = await refusedCallback(rebindEnv(), idp, provider);
      expect(res.status).toBe(302);
      expect(await env.DB.prepare("SELECT provider_subject FROM identity_tokens WHERE account_email = ?").bind("member@example.com").first())
        .toEqual({ provider_subject: "first-sub" });
    });

    it("a non-member gets not_invited, never account_bound (membership is checked first; no account-existence signal)", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const { idp } = identityMock("member@example.com", "intruder-sub");
      const res = await refusedCallback(rebindEnv({ MEMBERSHIP_ALLOWLIST: "someone-else@example.com" }), idp, provider);
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toMatch(/invitation-only/i);
      expect(html).not.toContain("already linked");
    });

    it("a partial grant from a rebinding identity: missing_scopes page and its grant IS revoked (the existing-grant skip is for the bound identity only)", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const before = await accountSnapshot("member@example.com");
      const { idp, revokeGrant } = identityMock("member@example.com", "intruder-sub", PARTIAL[provider].grant);
      const res = await refusedCallback(rebindEnv(), idp, provider);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Permissions needed");
      expect(revokeGrant).toHaveBeenCalledTimes(1);
      expect(await accountSnapshot("member@example.com")).toEqual(before);
    });

    it("REQUIRE_EXACT_PROVIDER_SCOPES=false does not bypass the rebind refusal", async () => {
      await seedBoundAccount("member@example.com", provider, "owner-sub");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { idp } = identityMock("member@example.com", "intruder-sub", PARTIAL[provider].grant);
        const res = await refusedCallback(rebindEnv({ REQUIRE_EXACT_PROVIDER_SCOPES: "false" }), idp, provider);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("Account already linked");
      } finally {
        warn.mockRestore();
      }
    });

    for (const flag of [undefined, "false", "TRUE", "1"]) {
      it(`flag ${JSON.stringify(flag)}: today's behaviour, the other identity rebinds (302)`, async () => {
        await seedBoundAccount("member@example.com", other, "owner-sub");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { idp } = identityMock("member@example.com", "new-idp-sub");
          const res = await refusedCallback(rebindEnv({ REFUSE_PROVIDER_REBIND: flag }), idp, provider);
          expect(res.status).toBe(302);
          expect(await env.DB.prepare("SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?").bind("member@example.com").first())
            .toEqual({ provider, provider_subject: "new-idp-sub" });
          // The documented provider switch reset ran.
          expect(await env.DB.prepare("SELECT next_sync_token FROM calendar_sync WHERE owner_subject = ?").bind("member@example.com").first())
            .toEqual({ next_sync_token: null });
        } finally {
          warn.mockRestore();
        }
      });
    }
  });

  // Decision G: REQUIRE_EXACT_PROVIDER_SCOPES exactly "false" lets a sign-in
  // with missing product scopes through (logged, nothing revoked); anything
  // else keeps O6's fail-closed refusal.
  describe(`/auth/callback REQUIRE_EXACT_PROVIDER_SCOPES (G, ${provider})`, () => {
    it("\"false\": a partial grant signs in (302 + code), nothing revoked, logs auth_callback_scopes_relaxed with the missing scopes", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { idp, revokeGrant } = grantingMock("operator@example.com", PARTIAL[provider].grant);
        const res = await refusedCallback(o6Env({ REQUIRE_EXACT_PROVIDER_SCOPES: "false" }), idp, provider);
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
        expect(revokeGrant).not.toHaveBeenCalled();
        const row = await env.DB.prepare("SELECT scopes, provider FROM identity_tokens WHERE account_email = ?")
          .bind("operator@example.com").first();
        expect(row).toEqual({ scopes: PARTIAL[provider].grant, provider });
        const lines = warn.mock.calls.map((c) => c.map((a) => JSON.stringify(a)).join(" "));
        const line = lines.find((l) => l.includes("auth_callback_scopes_relaxed"));
        expect(line).toBeDefined();
        expect(line).toContain(provider);
        expect(line).toMatch(provider === "google" ? /gmail\.send/ : /mail\.send/);
        expect(lines.some((l) => l.includes("auth_callback_missing_scopes"))).toBe(false);
        expect(lines.some((l) => l.includes("SECRET") || l.includes("operator@example.com"))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    for (const v of [undefined, "true", "FALSE", " false", "0"]) {
      it(`${JSON.stringify(v)}: a partial grant is refused (fail closed)`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { idp, revokeGrant } = grantingMock("operator@example.com", PARTIAL[provider].grant);
          const res = await refusedCallback(o6Env({ REQUIRE_EXACT_PROVIDER_SCOPES: v }), idp, provider);
          expect(res.status).toBe(403);
          expect(revokeGrant).toHaveBeenCalledTimes(1);
          expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
        } finally {
          warn.mockRestore();
        }
      });
    }
  });

  describe(`/auth/callback DEBUG_LOG granted-scope line (G, ${provider})`, () => {
    it("DEBUG_LOG=true: logs dbg_auth_callback_granted_scopes with the provider and the raw scope string, never a token or email", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { idp } = grantingMock("operator@example.com", PARTIAL[provider].grant);
        await refusedCallback(o6Env({ DEBUG_LOG: "true" }), idp, provider);
        const lines = info.mock.calls.map((c) => c.map(String).join(" "));
        const line = lines.find((l) => l.includes("dbg_auth_callback_granted_scopes"));
        expect(line).toBeDefined();
        expect(line).toContain(`"provider":"${provider}"`);
        expect(line).toContain(JSON.stringify(PARTIAL[provider].grant));
        const all = [...lines, ...warn.mock.calls.map((c) => c.map(String).join(" "))];
        expect(all.some((l) => l.includes("SECRET"))).toBe(false);
        expect(all.some((l) => l.includes("operator@example.com"))).toBe(false);
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    });

    for (const v of [undefined, "false", "TRUE"]) {
      it(`DEBUG_LOG ${JSON.stringify(v)}: no granted-scope line`, async () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        try {
          const { idp } = grantingMock("operator@example.com", FULL_UPSTREAM_GRANT);
          await refusedCallback(o6Env({ DEBUG_LOG: v }), idp, provider);
          expect(info.mock.calls.some((c) => c.map(String).join(" ").includes("dbg_auth_callback_granted_scopes"))).toBe(false);
        } finally {
          info.mockRestore();
        }
      });
    }
  });
}

// Review M1: a client asking for a scope outside its allowed_scopes is refused
// with invalid_scope BEFORE the IdP exchange. It used to be refused only after
// the grant was stored and the users row seeded, so the daily renewal sweep's
// create pass could still give that stored grant a push channel.
describe("/auth/callback client-capability violation is refused before the IdP exchange (M1)", () => {
  for (const provider of ["google", "microsoft"] as const) {
    it(`${provider}: no exchange, no identity lookup, nothing stored`, async () => {
      await env.DB.prepare("DELETE FROM calendar_sync").run();
      await env.DB.prepare("UPDATE oauth_clients SET allowed_scopes = 'scheduler:write' WHERE id = 'codemode'").run();
      const { idp, fetchIdentity } = grantingMock("operator@example.com", FULL_UPSTREAM_GRANT);
      const exchangeCode = vi.fn(idp.exchangeCode);
      const res = await refusedCallback(o6Env(), { ...idp, exchangeCode }, provider);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("state")).toBe("client-state");
      expect(loc.searchParams.get("code")).toBeNull();
      expect(exchangeCode).not.toHaveBeenCalled();
      expect(fetchIdentity).not.toHaveBeenCalled();
      expect(await counts()).toEqual({ oauth_codes: 0, identity_tokens: 0, users: 0 });
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_sync").first<{ n: number }>())!.n).toBe(0);
    });
  }

  it("a client allowed the requested scopes still signs in (the role entitlement still narrows admin later)", async () => {
    await env.DB.prepare("UPDATE oauth_clients SET allowed_scopes = 'scheduler:read scheduler:write' WHERE id = 'codemode'").run();
    const res = await refusedCallback(env as Env, mock("operator@example.com"));
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });
});

// Trial finding 1: nothing created a push channel for a new user (only an
// explicit subscribeWebhook did), so webhook replans never fired. A sign-in
// that stores the grant now ensures a channel, best-effort and off the
// redirect's critical path. test/setup.ts installs a no-op subscriber for
// every test; these opt in with a recording one.
describe("/auth/callback ensures a push channel (trial finding 1)", () => {
  type Call = { subject: string; provider: string };
  function recordingSubscriber() {
    const calls: Call[] = [];
    __setSignInSubscriberForTests(async (_e, subject, provider) => {
      calls.push({ subject, provider });
    });
    return calls;
  }
  afterEach(() => __setSignInSubscriberForTests(null));

  for (const provider of ["google", "microsoft"] as const) {
    it(`a successful ${provider} sign-in ensures a channel for the subject, on that provider`, async () => {
      const calls = recordingSubscriber();
      const { idp } = grantingMock("operator@example.com", FULL_UPSTREAM_GRANT);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(302);
      expect(calls).toEqual([{ subject: "operator@example.com", provider }]);
    });
  }

  it("a renamed member's channel is ensured under the ORIGINAL subject, not the token's new email", async () => {
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
      .bind("old@example.com", "member", 1, "2026-01-01T00:00:00Z").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind("old@example.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "fixed-sub").run();
    const calls = recordingSubscriber();
    const res = await refusedCallback(env as Env, mockWithFixedSubject("renamed@example.com", "fixed-sub"));
    expect(res.status).toBe(302);
    expect(calls).toEqual([{ subject: "old@example.com", provider: "google" }]);
  });

  it("a refused non-member never gets a channel", async () => {
    const calls = recordingSubscriber();
    const res = await refusedCallback(env as Env, mock("intruder@evil.com"));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a refused partial grant never gets a channel", async () => {
    const calls = recordingSubscriber();
    const { idp } = grantingMock("operator@example.com", PARTIAL.google.grant);
    const res = await refusedCallback(o6Env(), idp);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a refused provider rebind never gets a channel", async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await seedBoundAccount("member@example.com", "google", "owner-sub");
    const calls = recordingSubscriber();
    const { idp } = identityMock("member@example.com", "someone-else-sub");
    const res = await refusedCallback(rebindEnv(), idp);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  // Security F2: the subscribe used to run before narrowScopesForGrant, so a
  // sign-in refused with invalid_scope still provisioned a channel.
  for (const provider of ["google", "microsoft"] as const) {
    it(`a ${provider} sign-in refused for a client-capability violation (invalid_scope) never gets a channel`, async () => {
      await env.DB.prepare("UPDATE oauth_clients SET allowed_scopes = 'scheduler:write' WHERE id = 'codemode'").run();
      const calls = recordingSubscriber();
      const { idp } = grantingMock("operator@example.com", FULL_UPSTREAM_GRANT);
      const res = await refusedCallback(o6Env(), idp, provider);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("code")).toBeNull();
      expect(calls).toEqual([]);
    });
  }

  it("end to end: an invalid_scope sign-in leaves no calendar_sync row and never calls the provider", async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("UPDATE oauth_clients SET allowed_scopes = 'scheduler:write' WHERE id = 'codemode'").run();
    const cal = new MockCalendarProvider();
    __setSignInSubscriberForTests((e, subject, provider) =>
      ensureSubscriptionOnSignIn(e, subject, provider, () => cal));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await refusedCallback(env as Env, mock("operator@example.com"));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    expect(cal.getSubscribeCallCount()).toBe(0);
    expect(await getCalendarSync(env.DB, "operator@example.com", "primary")).toBeNull();
  });

  it("subscribes only once the authorization code row is written", async () => {
    const seen: number[] = [];
    __setSignInSubscriberForTests(async (e) => {
      const r = await e.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes WHERE subject = 'operator@example.com'")
        .first<{ n: number }>();
      seen.push(r?.n ?? 0);
    });
    const res = await refusedCallback(env as Env, mock("operator@example.com"));
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    expect(seen).toEqual([1]);
  });

  it("a failed sign-in (server_error) never gets a channel", async () => {
    const calls = recordingSubscriber();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await refusedCallback(env as Env, mock("operator@example.com", { exchangeThrows: true }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("server_error");
    expect(calls).toEqual([]);
  });

  it("a subscriber that rejects never fails the sign-in", async () => {
    __setSignInSubscriberForTests(async () => {
      throw new Error("boom");
    });
    const res = await refusedCallback(env as Env, mock("operator@example.com"));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("does not hold the redirect: the browser gets its 302 while the subscribe is still running (waitUntil)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    __setSignInSubscriberForTests(async () => {
      started = true;
      await gate;
    });
    __setIdentityProviderForTests(mock("operator@example.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    expect(started).toBe(true);
    release();
  });

  it("end to end: a first sign-in leaves a calendar_sync row with a live channel on the Google webhook URL", async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    const cal = new MockCalendarProvider();
    __setSignInSubscriberForTests((e, subject, provider) =>
      ensureSubscriptionOnSignIn(e, subject, provider, () => cal));
    vi.spyOn(console, "info").mockImplementation(() => {});
    __setIdentityProviderForTests(mock("operator@example.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: cookieHeader(cookie) });
    expect(res.status).toBe(302);
    await vi.waitFor(async () => {
      const row = await getCalendarSync(env.DB, "operator@example.com", "primary");
      expect(row?.channel_id).toMatch(/^mock-channel-/);
      expect(row?.channel_callback_url).toBe(`${env.OAUTH_ISSUER}/v1/webhook/google-calendar`);
    });
    expect(cal.getSubscribeCallCount()).toBe(1);
  });
});
