import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { mountStopChannelRoute } from "../../src/admin/stop-channel-route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser } from "../../src/db/users";
import { upsertCalendarSync, PRIMARY_CALENDAR_ID } from "../../src/db/calendar-sync";
import { storeIdentityTokens } from "../../src/auth/identity-store";

function makeApp(cal: MockCalendarProvider) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", cal);
    await next();
  });
  mountStopChannelRoute(app);
  return app;
}

async function seedAdminBearer(token: string, subject: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", "scheduler:read scheduler:write admin", "2099-01-01T00:00:00Z", null, null, subject).run();
}

describe("POST /admin/stop-channel", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await upsertUser(env.DB, "owner@example.com", "admin");
    await seedAdminBearer("tok", "owner@example.com");
  });

  it("stops the given channel id + resource id (scoped to the channel owner)", async () => {
    await upsertCalendarSync(env.DB, "chan-owner@example.com", PRIMARY_CALENDAR_ID, { channel_id: "ch-x" });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-x&resource_id=res-y",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-x", resourceId: "res-y" }]);
  });

  it("404 when the channel id is unknown", async () => {
    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-unknown&resource_id=res-y",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(404);
  });

  it("400s when params are missing", async () => {
    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/admin/stop-channel",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(400);
  });

  it("stops a channel given channel_id alone, using the row's stored resource_id", async () => {
    await upsertCalendarSync(env.DB, "chan-owner@example.com", PRIMARY_CALENDAR_ID, {
      channel_id: "ch-x",
      channel_resource_id: "res-stored",
    });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-x",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-x", resourceId: "res-stored" }]);
  });

  it("stops a Microsoft channel without a resource_id param (stored resourceId is empty)", async () => {
    await storeIdentityTokens(
      env,
      "chan-owner-ms2@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    await upsertCalendarSync(env.DB, "chan-owner-ms2@example.com", PRIMARY_CALENDAR_ID, {
      channel_id: "ch-ms",
      channel_resource_id: "",
    });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-ms",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-ms", resourceId: "" }]);
  });

  it("400s a Google row whose stored resourceId is the empty string and no resource_id param was given", async () => {
    // "" is falsy, same broken-Google-call shape as null — must 400 too, not
    // just a stored null.
    await upsertCalendarSync(env.DB, "chan-owner@example.com", PRIMARY_CALENDAR_ID, {
      channel_id: "ch-empty-google",
      channel_resource_id: "",
    });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-empty-google",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("missing_resource_id");
    expect(cal.getStoppedChannels()).toEqual([]);
  });

  it("falls back to the row's stored resourceId when resource_id is passed as an empty query string", async () => {
    // ?resource_id= (present but empty) must not be treated as "explicit" —
    // it would otherwise slip an empty resourceId through to Google's stop
    // call even when the row DOES have a good stored value.
    await upsertCalendarSync(env.DB, "chan-owner@example.com", PRIMARY_CALENDAR_ID, {
      channel_id: "ch-empty-query",
      channel_resource_id: "res-stored",
    });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-empty-query&resource_id=",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-empty-query", resourceId: "res-stored" }]);
  });

  it("400s a Google row whose stored resourceId is null and no resource_id param was given", async () => {
    // No stored resource_id at all (legacy/broken row) — must not fall through
    // to an empty-string resourceId, which would make Google's stop call 500.
    await upsertCalendarSync(env.DB, "chan-owner@example.com", PRIMARY_CALENDAR_ID, { channel_id: "ch-null-google" });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-null-google",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("missing_resource_id");
    expect(body.message).toMatch(/resourceId/);
    expect(cal.getStoppedChannels()).toEqual([]);
  });

  it("allows a Microsoft row whose stored resourceId is null and no resource_id param was given", async () => {
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await storeIdentityTokens(
      msEnv,
      "chan-owner-ms@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    await upsertCalendarSync(env.DB, "chan-owner-ms@example.com", PRIMARY_CALENDAR_ID, { channel_id: "ch-null-ms" });
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-null-ms",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      msEnv,
    );
    expect(res.status).toBe(200);
    expect(cal.getStoppedChannels()).toEqual([{ channelId: "ch-null-ms", resourceId: "" }]);
  });

  it("returns 401 without bearer", async () => {
    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-x&resource_id=res-y",
      { method: "POST" },
      { ...env },
    );
    expect(res.status).toBe(401);
  });

  it("403 insufficient_scope for an admin bearer without the admin scope", async () => {
    // beforeEach seeds an admin-scoped "tok"; overwrite it with a non-admin grant.
    const h = await hashToken("tok", hashingKey(env));
    await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
      .bind(h, "c", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, "owner@example.com").run();
    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/admin/stop-channel?channel_id=ch-x&resource_id=res-y",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      { ...env },
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
  });
});
