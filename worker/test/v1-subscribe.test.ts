import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v1 as app } from "../src/v1";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";
import {
  storeIdentityTokens,
  IdentityCredentialMissingError,
  IDENTITY_CHANGED_DURING_REFRESH,
} from "../src/auth/identity-store";
import { MicrosoftCalendarProvider } from "../src/providers/microsoft-calendar-provider";
import * as subscriptionManager from "../src/webhooks/subscription-manager";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../src/env";
import type { CalendarProvider } from "../src/providers/calendar-provider";
import { MockCalendarProvider } from "../src/providers/mock-calendar-provider";
import { upsertCalendarSync, getCalendarSync } from "../src/db/calendar-sync";
import { webhookCallbackUrl } from "../src/webhooks/callback-url";

async function seedBearer(token: string, subject: string, scopes = "scheduler:read scheduler:write") {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users", "calendar_sync", "identity_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/webhook/subscribe", () => {
  it("401 without bearer", async () => {
    const res = await app.request("/webhook/subscribe", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("selects the Microsoft calendar provider and webhook callback for a microsoft subject", async () => {
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await upsertUser(env.DB, "ms-owner@example.com");
    await seedBearer("tok", "ms-owner@example.com");
    await storeIdentityTokens(
      msEnv,
      "ms-owner@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    const spy = vi.spyOn(subscriptionManager, "ensureSubscription").mockResolvedValue({ subscribed: true });

    const res = await app.request(
      "/webhook/subscribe",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      msEnv,
    );

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.callbackUrl).toBe(`${msEnv.OAUTH_ISSUER}/v1/webhook/microsoft-calendar`);
    expect(call.calendar).toBeInstanceOf(MicrosoftCalendarProvider);
  });
});

// Drives the real ensureSubscription against D1, with a mock calendar injected
// the way the handler's tests-only `c.var.calendarProvider` hook expects.
describe("POST /v1/webhook/subscribe — subscribed reports the stored channel", () => {
  const OWNER = "owner@example.com";
  const DAY = 24 * 3600 * 1000;

  function mount(cal: CalendarProvider) {
    const wrapped = new OpenAPIHono<{ Bindings: Env; Variables: { calendarProvider?: CalendarProvider } }>();
    wrapped.use("*", async (c, next) => {
      c.set("calendarProvider", cal);
      await next();
    });
    wrapped.route("/", app);
    return wrapped;
  }

  async function post(cal: CalendarProvider) {
    const res = await mount(cal).request(
      "/webhook/subscribe",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; subscribed: boolean };
  }

  async function seedGrant() {
    await storeIdentityTokens(env, OWNER, { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google");
  }

  async function seedChannel(expiresAt: string, callbackUrl = webhookCallbackUrl(env, "google")) {
    await upsertCalendarSync(env.DB, OWNER, "primary", {
      channel_id: "live-chan",
      channel_token: "tok",
      channel_expires_at: expiresAt,
      channel_resource_id: "res",
      channel_callback_url: callbackUrl,
    });
  }

  beforeEach(async () => {
    await upsertUser(env.DB, OWNER);
    await seedBearer("tok", OWNER);
  });

  it("true when a live channel already exists (ensureSubscription did no work)", async () => {
    await seedGrant();
    await seedChannel(new Date(Date.now() + 6 * DAY).toISOString());
    const cal = new MockCalendarProvider();
    const subscribe = vi.spyOn(cal, "subscribeToChanges");
    const body = await post(cal);
    expect(subscribe).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, subscribed: true });
  });

  it("true when a channel is newly created", async () => {
    await seedGrant();
    const body = await post(new MockCalendarProvider());
    expect(body.subscribed).toBe(true);
    expect((await getCalendarSync(env.DB, OWNER, "primary"))?.channel_id).toMatch(/^mock-channel-/);
  });

  it("false when the store is refused and no row exists (no grant, as after an offboard)", async () => {
    const body = await post(new MockCalendarProvider());
    expect(body).toEqual({ ok: true, subscribed: false });
  });

  it("false when only an expired channel is stored", async () => {
    // No grant, so the rotate's store is refused and the expired row stays.
    await seedChannel(new Date(Date.now() - DAY).toISOString());
    const body = await post(new MockCalendarProvider());
    expect(body.subscribed).toBe(false);
  });

  it("false when the stored channel points at another callback URL", async () => {
    await seedChannel(new Date(Date.now() + 6 * DAY).toISOString(), "https://other.example/v1/webhook/google-calendar");
    const body = await post(new MockCalendarProvider());
    expect(body.subscribed).toBe(false);
  });

  it("false when ensureSubscription reports work but no channel is stored", async () => {
    vi.spyOn(subscriptionManager, "ensureSubscription").mockResolvedValue({ subscribed: true });
    const body = await post(new MockCalendarProvider());
    expect(body.subscribed).toBe(false);
  });

  it("true when a near-expiry channel's renew and rotate both fail but it is still live", async () => {
    await seedGrant();
    await seedChannel(new Date(Date.now() + DAY).toISOString()); // inside the 48h renew threshold
    const cal = new MockCalendarProvider({ supportsRenew: true });
    cal.renewSubscription = async () => { throw new Error("graph 503"); };
    vi.spyOn(cal, "subscribeToChanges").mockRejectedValue(new Error("google 503"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await post(cal);
    expect(body).toEqual({ ok: true, subscribed: true });
    const line = warn.mock.calls.find((c) => c[0] === "subscribe_webhook_failed");
    expect(line?.[1]).toEqual({ provider: "google", reason: "error", error: "Error" });
  });

  it("false when a transient error leaves no live channel", async () => {
    await seedGrant();
    const cal = new MockCalendarProvider();
    vi.spyOn(cal, "subscribeToChanges").mockRejectedValue(new Error("google 503"));
    const body = await post(cal);
    expect(body).toEqual({ ok: true, subscribed: false });
  });

  it.each([
    ["a refused refresh", () => new Error('google refresh failed: {"error":"invalid_grant"}')],
    ["a revoked Microsoft refresh", () => new Error("microsoft refresh failed: {\"error\":\"invalid_grant\",\"error_description\":\"AADSTS700082\"}")],
    ["a wiped credential", () => new IdentityCredentialMissingError()],
    ["an identity change mid-refresh", () => new Error(IDENTITY_CHANGED_DURING_REFRESH)],
  ])("false when %s makes the grant unusable, even with a live channel", async (_what, err) => {
    await seedGrant();
    await seedChannel(new Date(Date.now() + DAY).toISOString());
    const cal = new MockCalendarProvider();
    vi.spyOn(cal, "subscribeToChanges").mockRejectedValue(err());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await post(cal);
    expect(body).toEqual({ ok: true, subscribed: false });
    const line = warn.mock.calls.find((c) => c[0] === "subscribe_webhook_failed");
    expect(line?.[1]).toMatchObject({ provider: "google", reason: "grant_unusable" });
  });

  it("false when the caller's provider is switched off (ProviderDisabledError), even with a live channel", async () => {
    const msOn = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(msOn, OWNER, { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    await seedChannel(new Date(Date.now() + 6 * DAY).toISOString(), webhookCallbackUrl(env, "microsoft"));
    const res = await app.request(
      "/webhook/subscribe",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env, MS_PROVIDER_ENABLED: "false" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subscribed: false });
  });
});
