import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { oauthProviderApp } from "../src/auth/oauth-provider";
import type { Env } from "../src/env";

// O7: /oauth/authorize renders the disclosure chooser whenever PRIVACY_URL is
// set, even with a single provider; with it unset, a Google-only deployment
// keeps its 302 straight to Google (prod parity). Driven purely through env
// bindings, with the real identity providers (no injected IdP mock).

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function makeAuthApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/oauth", oauthProviderApp);
  return app;
}

function authorizeUrl(extra: Record<string, string> = {}): string {
  const u = new URL("https://x/oauth/authorize");
  Object.entries({
    response_type: "code", client_id: "disclosure-client", redirect_uri: "https://app.example/cb",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "scheduler:read", state: "st",
    ...extra,
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.toString();
}

const GOOGLE_ONLY = { ...env, MS_PROVIDER_ENABLED: "false" } as Env;
const TRIAL = {
  ...GOOGLE_ONLY,
  PRIVACY_URL: "https://trial.example/privacy",
  TERMS_URL: "https://trial.example/terms",
  DEPLOYMENT_LABEL: "Trial",
} as Env;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM oauth_clients WHERE id = ?").bind("disclosure-client").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("disclosure-client", "Disclosure", "pkce", JSON.stringify(["https://app.example/cb"]), "2026-01-01T00:00:00Z").run();
});

describe("/oauth/authorize disclosure chooser", () => {
  it("Google-only with PRIVACY_URL set: 200 chooser HTML with disclosure, not a 302", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, TRIAL);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain('href="https://trial.example/privacy"');
    expect(html).toContain('href="https://trial.example/terms"');
    expect(html).toContain("Limited Use requirements");
    expect(html).toContain('<span class="badge">Trial</span>');
    expect(html).toMatch(/<a class="btn btn-google" href="\/oauth\/authorize\?[^"]*provider=google/);
    expect(html).not.toContain("btn-microsoft");
    expect(html).toContain("state=st");
  });

  it("the chooser's Google link proceeds to the IdP (provider= given skips the chooser)", async () => {
    const res = await makeAuthApp().request(authorizeUrl({ provider: "google" }), { redirect: "manual" }, TRIAL);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hostname).toBe("accounts.google.com");
  });

  it("Google-only with PRIVACY_URL unset: unchanged 302 to Google (prod parity)", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, GOOGLE_ONLY);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).hostname).toBe("accounts.google.com");
  });

  it("Google-only with PRIVACY_URL blank: still a 302", async () => {
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, { ...GOOGLE_ONLY, PRIVACY_URL: " " } as Env);
    expect(res.status).toBe(302);
  });

  it("two providers offered with PRIVACY_URL set: both buttons plus disclosure", async () => {
    const both = { ...TRIAL, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "ms-cid" } as Env;
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, both);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("btn-google");
    expect(html).toContain("btn-microsoft");
    expect(html).toContain("Limited Use requirements");
  });

  it("two providers offered without PRIVACY_URL: chooser unchanged, no disclosure or badge", async () => {
    const both = { ...GOOGLE_ONLY, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "ms-cid", DEPLOYMENT_LABEL: "Trial" } as Env;
    const res = await makeAuthApp().request(authorizeUrl(), { redirect: "manual" }, both);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("btn-google");
    expect(html).toContain("btn-microsoft");
    expect(html).not.toContain('class="disclosure"');
    expect(html).not.toContain('class="badge"');
  });
});
